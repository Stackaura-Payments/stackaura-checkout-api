import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  BusinessVerificationService,
  parseBusinessProfile,
} from './business-verification.service';
import { PrismaService } from '../prisma/prisma.service';

const profile = {
  legalName: 'Example Pty Ltd',
  registrationNumber: '2026/123456/07',
  country: 'za',
  businessAddress: 'Example address',
  businessActivity: 'Software',
  representativeName: 'Example Person',
};
describe('Business verification', () => {
  const prisma = {
    user: { findUnique: jest.fn() },
    membership: { findUnique: jest.fn(), findFirst: jest.fn() },
    merchant: { create: jest.fn() },
    businessVerification: {
      findUnique: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  let service: BusinessVerificationService;
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.user.findUnique.mockResolvedValue({ isActive: true });
    prisma.membership.findUnique.mockResolvedValue({ role: 'OWNER' });
    prisma.$transaction.mockImplementation(
      (callback: (tx: typeof prisma) => unknown) => callback(prisma),
    );
    service = new BusinessVerificationService(
      prisma as unknown as PrismaService,
    );
  });
  it('normalizes country and discards attempted status overrides', () => {
    expect(parseBusinessProfile({ ...profile, status: 'VERIFIED' })).toEqual({
      ...profile,
      country: 'ZA',
    });
  });
  it.each([
    null,
    { ...profile, country: 'South Africa' },
    { ...profile, legalName: 'a'.repeat(201) },
    { ...profile, registrationNumber: 123 },
    { ...profile, legalName: '\nname' },
  ])('rejects malformed profile %#', (body) => {
    expect(() => parseBusinessProfile(body)).toThrow(BadRequestException);
  });
  it('denies access across workspaces', async () => {
    prisma.membership.findUnique.mockResolvedValue(null);
    await expect(service.get('user', 'other-merchant')).rejects.toThrow(
      ForbiddenException,
    );
    expect(prisma.businessVerification.findUnique).not.toHaveBeenCalled();
  });
  it('denies inactive accounts and non-owner writes', async () => {
    prisma.user.findUnique.mockResolvedValue({ isActive: false });
    await expect(
      service.save('user', 'merchant', profile, false),
    ).rejects.toThrow(UnauthorizedException);
    prisma.user.findUnique.mockResolvedValue({ isActive: true });
    prisma.membership.findUnique.mockResolvedValue({ role: 'MEMBER' });
    await expect(
      service.save('user', 'merchant', profile, false),
    ).rejects.toThrow(ForbiddenException);
  });
  it('records a submission without claiming verification or activating payments', async () => {
    prisma.businessVerification.findUnique.mockResolvedValue(null);
    prisma.businessVerification.create.mockImplementation(({ data }) =>
      Promise.resolve(data),
    );
    const result = await service.save(
      'user',
      'merchant',
      { ...profile, status: 'VERIFIED' },
      true,
    );
    expect(result.status).toBe('SUBMITTED');
    expect(result.submittedAt).toBeInstanceOf(Date);
    expect(prisma.merchant.create).not.toHaveBeenCalled();
  });
  it('requires all fields to submit but permits an incomplete draft', async () => {
    await expect(
      service.save('user', 'merchant', { ...profile, legalName: '' }, true),
    ).rejects.toThrow(BadRequestException);
    prisma.businessVerification.findUnique.mockResolvedValue(null);
    await service.save(
      'user',
      'merchant',
      { ...profile, legalName: '' },
      false,
    );
    expect(
      (prisma.businessVerification.create.mock.calls as unknown[][])[0][0],
    ).toMatchObject({
      data: { status: 'DRAFT' },
    });
  });
  it.each(['SUBMITTED', 'UNDER_REVIEW', 'VERIFIED'])(
    'does not overwrite a %s profile',
    async (status) => {
      prisma.businessVerification.findUnique.mockResolvedValue({ status });
      await expect(
        service.save('user', 'merchant', profile, false),
      ).rejects.toThrow(ConflictException);
      expect(prisma.businessVerification.updateMany).not.toHaveBeenCalled();
    },
  );
  it('detects concurrent submission during a draft update', async () => {
    prisma.businessVerification.findUnique.mockResolvedValue({
      status: 'DRAFT',
    });
    prisma.businessVerification.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.save('user', 'merchant', profile, false),
    ).rejects.toThrow(ConflictException);
  });
  it('creates only an inactive first social workspace and no API key', async () => {
    prisma.user.findUnique.mockResolvedValue({
      email: 'example@example.test',
      isActive: true,
      externalIdentities: [{ id: 'identity' }],
    });
    prisma.membership.findFirst.mockResolvedValue(null);
    prisma.merchant.create.mockResolvedValue({
      id: 'merchant',
      name: 'Example',
      isActive: false,
    });
    await service.createWorkspace('user', { businessName: 'Example' });
    expect(
      (prisma.merchant.create.mock.calls as unknown[][])[0][0],
    ).toMatchObject({
      data: {
        isActive: false,
        memberships: { create: { userId: 'user', role: 'OWNER' } },
      },
    });
    prisma.membership.findFirst.mockResolvedValue({ id: 'existing' });
    await expect(
      service.createWorkspace('user', { businessName: 'Example' }),
    ).rejects.toThrow(ConflictException);
  });
});
