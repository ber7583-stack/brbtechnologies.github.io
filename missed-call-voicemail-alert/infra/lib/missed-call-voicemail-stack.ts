import * as cdk from "aws-cdk-lib";
import * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigatewayIntegrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
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

    const webhookSecret = new secretsmanager.Secret(this, "GvWebhookSecret", {
      description: "Shared secret for Gmail Apps Script → GV webhook",
      generateSecretString: {
        passwordLength: 32,
        excludePunctuation: true,
      },
    });

    const optOutTable = new dynamodb.Table(this, "SmsOptOut", {
      partitionKey: { name: "phone", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const mmsBucket = new s3.Bucket(this, "MmsMedia", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [
        { id: "expire-mms-audio", expiration: cdk.Duration.days(7) },
      ],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const gvSessionSecret = new secretsmanager.Secret(this, "GvSessionSecret", {
      description: "Google Voice browser session cookies for voicemail recording download",
      secretStringValue: cdk.SecretValue.unsafePlainText(
        JSON.stringify({ version: 1, cookies: [] })
      ),
    });

    const gvWebhookFn = new lambda.Function(this, "GvWebhook", {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "handler.handler",
      code: lambda.Code.fromAsset(
        path.join(__dirname, "../../lambda/gv_webhook")
      ),
      timeout: cdk.Duration.seconds(90),
      memorySize: 512,
      environment: {
        RECIPIENT_PHONE: CONFIG.recipientPhone,
        RECIPIENT_EMAIL: CONFIG.recipientEmail,
        SENDER_EMAIL: CONFIG.senderEmail,
        ORIGINATION_IDENTITY: CONFIG.originationIdentity,
        WEBHOOK_SECRET: webhookSecret.secretValue.unsafeUnwrap(),
        OPT_OUT_TABLE: optOutTable.tableName,
        MMS_BUCKET: mmsBucket.bucketName,
        MMS_MAX_AUDIO_BYTES: String(CONFIG.mmsMaxAudioBytes),
        GV_SESSION_SECRET_ARN: gvSessionSecret.secretArn,
      },
    });

    gvSessionSecret.grantRead(gvWebhookFn);

    optOutTable.grantReadData(gvWebhookFn);
    mmsBucket.grantReadWrite(gvWebhookFn);
    mmsBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "AllowSmsVoiceMmsRead",
        principals: [new iam.ServicePrincipal("sms-voice.amazonaws.com")],
        actions: ["s3:GetObject"],
        resources: [mmsBucket.arnForObjects("*")],
        conditions: {
          StringEquals: { "aws:SourceAccount": this.account },
        },
      })
    );
    gvWebhookFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["sms-voice:SendTextMessage", "sms-voice:SendMediaMessage"],
        resources: ["*"],
      })
    );
    gvWebhookFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendEmail", "ses:SendRawEmail"],
        resources: ["*"],
      })
    );

    const httpApi = new apigatewayv2.HttpApi(this, "GvWebhookApi", {
      apiName: "missed-call-gv-webhook",
      description: "Receives Google Voice voicemail emails from Gmail Apps Script",
    });

    httpApi.addRoutes({
      path: "/webhook",
      methods: [apigatewayv2.HttpMethod.POST],
      integration: new apigatewayIntegrations.HttpLambdaIntegration(
        "GvWebhookIntegration",
        gvWebhookFn
      ),
    });

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

    new cdk.CfnOutput(this, "GoogleVoiceNumber", {
      value: CONFIG.googleVoiceNumber,
      description: "Forward unanswered Verizon calls here",
    });

    new cdk.CfnOutput(this, "WebhookUrl", {
      value: `${httpApi.apiEndpoint}/webhook`,
      description: "Paste into google-voice/gmail-trigger.gs",
    });

    new cdk.CfnOutput(this, "WebhookSecret", {
      value: webhookSecret.secretValue.unsafeUnwrap(),
      description: "Paste into google-voice/gmail-trigger.gs",
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
