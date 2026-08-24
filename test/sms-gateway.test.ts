/**
 * Unit coverage for the SMS gateway seam (src/sms/gateway.ts): the mock's
 * recording behavior and the shared invite-message builder both admin and
 * manager invite routes use.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockSmsGateway, buildInviteMessage } from '../src/sms/gateway.js';

test('MockSmsGateway records every send and always reports success', async () => {
  const gateway = new MockSmsGateway();
  const first = await gateway.send('+15550001234', 'hello');
  const second = await gateway.send('+15559998888', 'world');

  assert.deepEqual(first, { sent: true });
  assert.deepEqual(second, { sent: true });
  assert.deepEqual(gateway.sent, [
    { phone: '+15550001234', message: 'hello' },
    { phone: '+15559998888', message: 'world' },
  ]);
});

test('buildInviteMessage includes the site name, Restroom Hero branding, and the sign-in link', () => {
  const message = buildInviteMessage('Central Plaza', 'https://example.com');
  assert.equal(
    message,
    'Central Plaza invited you to Restroom Hero. Sign in at https://example.com/auth/login to get started.',
  );
});
