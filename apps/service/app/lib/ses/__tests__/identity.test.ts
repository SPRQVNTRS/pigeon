import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  SESv2Client,
  CreateEmailIdentityCommand,
  GetEmailIdentityCommand,
  DeleteEmailIdentityCommand,
  PutEmailIdentityDkimSigningAttributesCommand,
} from '@aws-sdk/client-sesv2';
import { resetSesClients } from '../client';

// Mock the SESv2Client
const sesMock = mockClient(SESv2Client);

// Import identity functions after setting up the mock
const { createIdentity, getIdentity, deleteIdentity } = await import('../identity');

const DOMAIN = 'mail.example.com';
const REGION = 'eu-central-1';
const TOKENS = ['token1abc', 'token2def', 'token3ghi'];

describe('SES identity wrapper', () => {
  beforeEach(() => {
    sesMock.reset();
    resetSesClients();
  });

  afterEach(() => {
    sesMock.reset();
    resetSesClients();
  });

  describe('createIdentity', () => {
    it('skips PutDkimSigningAttributes when SES auto-populated tokens on CreateEmailIdentity', async () => {
      // Simulates eu-west-1 where SES auto-configures EasyDKIM
      sesMock.on(CreateEmailIdentityCommand).resolves({});
      sesMock.on(GetEmailIdentityCommand).resolves({
        VerifiedForSendingStatus: false,
        DkimAttributes: {
          Status: 'PENDING',
          Tokens: TOKENS,
          SigningEnabled: true,
        },
      });

      const result = await createIdentity({ domain: DOMAIN, region: REGION });

      expect(result.dkimTokens).toEqual(TOKENS);
      // Only 2 calls: Create + Get (Put is skipped because tokens are already present)
      expect(sesMock.calls()).toHaveLength(2);
      expect(sesMock.call(0).args[0]).toBeInstanceOf(CreateEmailIdentityCommand);
      expect(sesMock.call(1).args[0]).toBeInstanceOf(GetEmailIdentityCommand);
    });

    it('calls PutDkimSigningAttributes when SES did not auto-populate tokens', async () => {
      // Simulates regions where automatic EasyDKIM is not triggered
      sesMock.on(CreateEmailIdentityCommand).resolves({});
      sesMock.on(PutEmailIdentityDkimSigningAttributesCommand).resolves({});
      sesMock
        .on(GetEmailIdentityCommand)
        .resolvesOnce({ DkimAttributes: { Status: 'NOT_STARTED', Tokens: [] } })
        .resolves({
          VerifiedForSendingStatus: false,
          DkimAttributes: { Status: 'PENDING', Tokens: TOKENS, SigningEnabled: true },
        });

      const result = await createIdentity({ domain: DOMAIN, region: REGION });

      expect(result.dkimTokens).toEqual(TOKENS);
      // 4 calls: Create + Get (empty) + Put + Get (with tokens)
      expect(sesMock.calls()).toHaveLength(4);
      expect(sesMock.call(0).args[0]).toBeInstanceOf(CreateEmailIdentityCommand);
      expect(sesMock.call(1).args[0]).toBeInstanceOf(GetEmailIdentityCommand);
      expect(sesMock.call(2).args[0]).toBeInstanceOf(PutEmailIdentityDkimSigningAttributesCommand);
      expect(sesMock.call(3).args[0]).toBeInstanceOf(GetEmailIdentityCommand);
    });
  });

  describe('getIdentity', () => {
    it('returns parsed identity info', async () => {
      sesMock.on(GetEmailIdentityCommand).resolves({
        VerifiedForSendingStatus: true,
        DkimAttributes: {
          Status: 'SUCCESS',
          Tokens: TOKENS,
          SigningEnabled: true,
        },
      });

      const info = await getIdentity({ domain: DOMAIN, region: REGION });

      expect(info.name).toBe(DOMAIN);
      expect(info.verifiedForSending).toBe(true);
      expect(info.dkim.status).toBe('SUCCESS');
      expect(info.dkim.tokens).toEqual(TOKENS);
      expect(info.dkim.signingEnabled).toBe(true);
    });

    it('defaults to NOT_STARTED when DkimAttributes are missing', async () => {
      sesMock.on(GetEmailIdentityCommand).resolves({
        VerifiedForSendingStatus: false,
      });

      const info = await getIdentity({ domain: DOMAIN, region: REGION });
      expect(info.dkim.status).toBe('NOT_STARTED');
      expect(info.dkim.tokens).toEqual([]);
    });
  });

  describe('deleteIdentity', () => {
    it('calls DeleteEmailIdentityCommand', async () => {
      sesMock.on(DeleteEmailIdentityCommand).resolves({});

      await deleteIdentity({ domain: DOMAIN, region: REGION });

      expect(sesMock.calls()).toHaveLength(1);
      const call = sesMock.calls()[0];
      expect(call?.args[0].input).toMatchObject({ EmailIdentity: DOMAIN });
    });
  });
});
