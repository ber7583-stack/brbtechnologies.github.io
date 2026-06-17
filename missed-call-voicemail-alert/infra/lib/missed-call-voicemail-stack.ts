import * as cdk from "aws-cdk-lib";
import * as connect from "aws-cdk-lib/aws-connect";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3n from "aws-cdk-lib/aws-s3-notifications";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subs from "aws-cdk-lib/aws-sns-subscriptions";
import { Construct } from "constructs";
import * as fs from "fs";
import * as path from "path";

const CONFIG = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../../config/defaults.json"), "utf8")
);

export class MissedCallVoicemailStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const connectInstance = new connect.CfnInstance(this, "ConnectInstance", {
      identityManagementType: "CONNECT_MANAGED",
      instanceAlias: `missed-call-vm-${cdk.Names.uniqueId(this)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "")
        .slice(0, 20)}`,
      attributes: {
        inboundCalls: true,
        outboundCalls: false,
        contactflowLogs: true,
        contactLens: false,
        autoResolveBestVoices: true,
      },
    });

    const recordingsBucket = new s3.Bucket(this, "VoicemailRecordings", {
      bucketName: undefined,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [
        {
          id: "expire-recordings",
          expiration: cdk.Duration.days(CONFIG.recordingRetentionDays),
        },
      ],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const mmsBucket = new s3.Bucket(this, "MmsMedia", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [
        {
          id: "expire-mms-audio",
          expiration: cdk.Duration.days(CONFIG.recordingRetentionDays),
        },
      ],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const optOutTable = new dynamodb.Table(this, "SmsOptOut", {
      partitionKey: { name: "phone", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const ffmpegLayerArn = this.node.tryGetContext("ffmpegLayerArn") as
      | string
      | undefined;

    const processVoicemailFn = new lambda.Function(this, "ProcessVoicemail", {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "handler.handler",
      code: lambda.Code.fromAsset(
        path.join(__dirname, "../../lambda/process_voicemail")
      ),
      timeout: cdk.Duration.minutes(2),
      memorySize: 512,
      environment: {
        RECIPIENT_PHONE: CONFIG.recipientPhone,
        RECIPIENT_EMAIL: CONFIG.recipientEmail,
        SENDER_EMAIL: CONFIG.senderEmail,
        ORIGINATION_IDENTITY: CONFIG.originationIdentity,
        MMS_BUCKET: mmsBucket.bucketName,
        CONNECT_INSTANCE_ARN: connectInstance.attrArn,
        OPT_OUT_TABLE: optOutTable.tableName,
        MMS_MAX_AUDIO_BYTES: String(CONFIG.mmsMaxAudioBytes),
      },
      layers: ffmpegLayerArn
        ? [
            lambda.LayerVersion.fromLayerVersionArn(
              this,
              "FfmpegLayer",
              ffmpegLayerArn
            ),
          ]
        : undefined,
    });

    recordingsBucket.grantRead(processVoicemailFn);
    mmsBucket.grantReadWrite(processVoicemailFn);
    optOutTable.grantReadWriteData(processVoicemailFn);

    processVoicemailFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["connect:DescribeContact"],
        resources: [connectInstance.attrArn, `${connectInstance.attrArn}/*`],
      })
    );

    processVoicemailFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["sms-voice:SendMediaMessage", "sms-voice:SendTextMessage"],
        resources: ["*"],
      })
    );

    processVoicemailFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendRawEmail", "ses:SendEmail"],
        resources: ["*"],
      })
    );

    recordingsBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(processVoicemailFn),
      { suffix: ".wav" }
    );

    const inboundSmsFn = new lambda.Function(this, "InboundSmsHandler", {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "handler.handler",
      code: lambda.Code.fromAsset(
        path.join(__dirname, "../../lambda/inbound_sms")
      ),
      timeout: cdk.Duration.seconds(30),
      environment: {
        OWNER_PHONE: CONFIG.recipientPhone,
        ORIGINATION_IDENTITY: CONFIG.originationIdentity,
        OPT_OUT_TABLE: optOutTable.tableName,
        HELP_MESSAGE: CONFIG.helpMessage,
        STOP_MESSAGE: CONFIG.stopMessage,
      },
    });

    optOutTable.grantReadWriteData(inboundSmsFn);
    inboundSmsFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["sms-voice:SendTextMessage"],
        resources: ["*"],
      })
    );

    const inboundTopic = new sns.Topic(this, "InboundSmsTopic", {
      displayName: "Missed-call alert inbound SMS",
    });
    inboundTopic.addSubscription(new subs.LambdaSubscription(inboundSmsFn));

    const flow = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, "../../connect/voicemail-flow.json"),
        "utf8"
      )
    ) as {
      Actions: Array<{
        Identifier: string;
        Parameters?: { InputTimeLimitSeconds?: number };
      }>;
    };
    const recordAction = flow.Actions.find(
      (action) => action.Identifier === "RecordVoicemail"
    );
    if (recordAction?.Parameters) {
      recordAction.Parameters.InputTimeLimitSeconds = CONFIG.maxVoicemailSeconds;
    }
    const flowContent = JSON.stringify(flow);

    new connect.CfnContactFlow(this, "VoicemailInboundFlow", {
      instanceArn: connectInstance.attrArn,
      name: "MissedCallVoicemail",
      type: "CONTACT_FLOW",
      description: "Capture voicemail for missed-call SMS alerts",
      content: flowContent,
      state: "ACTIVE",
    });

    new cdk.CfnOutput(this, "ConnectInstanceArn", {
      value: connectInstance.attrArn,
      description: "Amazon Connect instance ARN — claim a phone number here",
    });

    new cdk.CfnOutput(this, "ConnectInstanceAlias", {
      value: connectInstance.instanceAlias ?? connectInstance.ref,
    });

    new cdk.CfnOutput(this, "RecordingsBucket", {
      value: recordingsBucket.bucketName,
      description: "Point Connect call recordings to this bucket",
    });

    new cdk.CfnOutput(this, "MmsBucket", {
      value: mmsBucket.bucketName,
    });

    new cdk.CfnOutput(this, "InboundSmsTopicArn", {
      value: inboundTopic.topicArn,
      description:
        "Subscribe this SNS topic to inbound SMS on your 10DLC number in End User Messaging console",
    });

    new cdk.CfnOutput(this, "OriginationIdentity", {
      value: CONFIG.originationIdentity,
    });

    new cdk.CfnOutput(this, "RecipientPhone", {
      value: CONFIG.recipientPhone,
    });
  }
}
