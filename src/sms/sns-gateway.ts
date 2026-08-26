/**
 * Real SMS delivery via Amazon SNS (SDD §6, the same account/region Cognito's
 * own SMS OTP already sends through -- see infra/modules/cognito). Credentials
 * come from the default provider chain (the instance/task role Terraform
 * grants `sns:Publish` to); nothing is read from disk or hardcoded here.
 *
 * `send` never throws: any SDK/network failure is caught and reported via
 * `SmsSendResult.sent = false` instead, per the gateway seam's contract
 * (src/sms/gateway.ts) -- a failed text must not block the already-persisted
 * invite it's reporting on.
 */
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { getEnv } from '../config/env.js';
import type { SmsGateway, SmsSendResult } from './gateway.js';

export class SnsSmsGateway implements SmsGateway {
  private readonly client: SNSClient;

  constructor() {
    // Named APP_AWS_REGION, not AWS_REGION, to stay unambiguous against any
    // AWS-reserved or platform-injected variable of that bare name (see
    // infra/modules/ec2_host's user_data.sh.tpl, which sets it).
    this.client = new SNSClient({ region: getEnv('APP_AWS_REGION') ?? 'us-east-1' });
  }

  async send(phone: string, message: string): Promise<SmsSendResult> {
    try {
      await this.client.send(
        new PublishCommand({
          PhoneNumber: phone,
          Message: message,
          MessageAttributes: {
            'AWS.SNS.SMS.SMSType': {
              DataType: 'String',
              StringValue: 'Transactional',
            },
          },
        }),
      );
      return { sent: true };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // eslint-disable-next-line no-console -- minimal scaffold logging; replaced by structured logging in a later phase.
      console.error('SMS send failed', { phone, reason });
      return { sent: false, error: reason };
    }
  }
}
