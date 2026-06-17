#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { MissedCallVoicemailStack } from "../lib/missed-call-voicemail-stack";

const app = new cdk.App();

new MissedCallVoicemailStack(app, "MissedCallVoicemailAlert", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
  },
  description:
    "Personal missed-call voicemail alerts via Amazon Connect + AWS 10DLC MMS",
});
