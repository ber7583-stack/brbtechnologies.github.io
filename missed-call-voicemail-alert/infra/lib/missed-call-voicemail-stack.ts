import * as cdk from "aws-cdk-lib";
import * as connect from "aws-cdk-lib/aws-connect";
import * as cr from "aws-cdk-lib/custom-resources";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3n from "aws-cdk-lib/aws-s3-notifications";
import * as ses from "aws-cdk-lib/aws-ses";
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

    recordingsBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "AllowConnectRecordings",
        principals: [new iam.ServicePrincipal("connect.amazonaws.com")],
        actions: ["s3:PutObject", "s3:GetBucketAcl"],
        resources: [
          recordingsBucket.bucketArn,
          recordingsBucket.arnForObjects("*"),
        ],
        conditions: {
          StringEquals: { "aws:SourceAccount": this.account },
          ArnLike: {
            "aws:SourceArn": `${connectInstance.attrArn}/*`,
          },
        },
      })
    );

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

    new ses.CfnEmailIdentity(this, "SenderEmail", {
      emailIdentity: CONFIG.senderEmail,
    });

    const optOutTable = new dynamodb.Table(this, "SmsOptOut", {
      partitionKey: { name: "phone", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

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

    inboundTopic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "AllowSmsVoicePublish",
        principals: [new iam.ServicePrincipal("sms-voice.amazonaws.com")],
        actions: ["sns:Publish"],
        resources: [inboundTopic.topicArn],
        conditions: {
          StringEquals: { "aws:SourceAccount": this.account },
        },
      })
    );

    const flowContent = fs
      .readFileSync(
        path.join(__dirname, "../../connect/voicemail-flow.json"),
        "utf8"
      )
      .replace(
        /\{\{MAX_VOICEMAIL_SECONDS\}\}/g,
        String(CONFIG.maxVoicemailSeconds)
      );

    const voicemailFlow = new connect.CfnContactFlow(this, "VoicemailInboundFlow", {
      instanceArn: connectInstance.attrArn,
      name: "MissedCallVoicemail",
      type: "CONTACT_FLOW",
      description: "Capture voicemail for missed-call SMS alerts",
      content: flowContent,
      state: "ACTIVE",
    });

    const inboundDid = new connect.CfnPhoneNumber(this, "InboundDid", {
      targetArn: connectInstance.attrArn,
      countryCode: "US",
      type: "DID",
      description: "Missed-call voicemail inbound number",
    });
    inboundDid.addDependency(connectInstance);

    const instanceId = cdk.Fn.select(
      1,
      cdk.Fn.split("/instance/", connectInstance.attrArn)
    );
    const contactFlowId = cdk.Fn.select(
      1,
      cdk.Fn.split("/contact-flow/", voicemailFlow.attrContactFlowArn)
    );
    const phoneNumberId = cdk.Fn.select(
      1,
      cdk.Fn.split("/phone-number/", inboundDid.attrPhoneNumberArn)
    );

    const associateDidFlow = new cr.AwsCustomResource(this, "AssociateInboundDidFlow", {
      onCreate: {
        service: "Connect",
        action: "associatePhoneNumberContactFlow",
        parameters: {
          InstanceId: instanceId,
          PhoneNumberId: phoneNumberId,
          ContactFlowId: contactFlowId,
        },
        physicalResourceId: cr.PhysicalResourceId.of("inbound-did-flow-assoc"),
      },
      onUpdate: {
        service: "Connect",
        action: "associatePhoneNumberContactFlow",
        parameters: {
          InstanceId: instanceId,
          PhoneNumberId: phoneNumberId,
          ContactFlowId: contactFlowId,
        },
        physicalResourceId: cr.PhysicalResourceId.of("inbound-did-flow-assoc"),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: [
          connectInstance.attrArn,
          `${connectInstance.attrArn}/*`,
        ],
      }),
    });
    associateDidFlow.node.addDependency(inboundDid);
    associateDidFlow.node.addDependency(voicemailFlow);

    const recordingsStorage = new connect.CfnInstanceStorageConfig(
      this,
      "CallRecordingsStorage",
      {
        instanceArn: connectInstance.attrArn,
        resourceType: "CALL_RECORDINGS",
        storageType: "S3",
        s3Config: {
          bucketName: recordingsBucket.bucketName,
          bucketPrefix: "connect/recordings/",
        },
      }
    );
    recordingsStorage.addDependency(connectInstance);

    new cr.AwsCustomResource(this, "EnableTwoWaySms", {
      onCreate: {
        service: "PinpointSMSVoiceV2",
        action: "updatePhoneNumber",
        parameters: {
          PhoneNumberId: CONFIG.originationIdentity,
          TwoWayEnabled: true,
          TwoWayChannelArn: inboundTopic.topicArn,
        },
        physicalResourceId: cr.PhysicalResourceId.of("two-way-sms-setup"),
      },
      onUpdate: {
        service: "PinpointSMSVoiceV2",
        action: "updatePhoneNumber",
        parameters: {
          PhoneNumberId: CONFIG.originationIdentity,
          TwoWayEnabled: true,
          TwoWayChannelArn: inboundTopic.topicArn,
        },
        physicalResourceId: cr.PhysicalResourceId.of("two-way-sms-setup"),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
    });

    new cdk.CfnOutput(this, "ConnectInboundDid", {
      value: inboundDid.attrAddress,
      description: "Forward unanswered calls here (Verizon *71)",
    });

    new cdk.CfnOutput(this, "ConnectInstanceArn", {
      value: connectInstance.attrArn,
    });

    new cdk.CfnOutput(this, "ConnectInstanceAlias", {
      value: connectInstance.instanceAlias ?? connectInstance.ref,
    });

    new cdk.CfnOutput(this, "RecordingsBucket", {
      value: recordingsBucket.bucketName,
    });

    new cdk.CfnOutput(this, "MmsBucket", {
      value: mmsBucket.bucketName,
    });

    new cdk.CfnOutput(this, "InboundSmsTopicArn", {
      value: inboundTopic.topicArn,
    });

    new cdk.CfnOutput(this, "OriginationIdentity", {
      value: CONFIG.originationIdentity,
    });

    new cdk.CfnOutput(this, "RecipientPhone", {
      value: CONFIG.recipientPhone,
    });

    new cdk.CfnOutput(this, "RecipientEmail", {
      value: CONFIG.recipientEmail,
    });
  }
}
