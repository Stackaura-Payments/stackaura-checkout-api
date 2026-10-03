import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { resolveDefaultMerchantPlanCode } from '../payments/monetization.config';

const fields = {
  legalName: 200,
  registrationNumber: 80,
  country: 2,
  businessAddress: 500,
  businessActivity: 500,
  representativeName: 200,
} as const;
type BusinessProfile = Record<keyof typeof fields, string>;
const hasControlCharacters = (value: string) =>
  Array.from(value).some((character) => character.charCodeAt(0) < 32);

export function parseBusinessProfile(body: unknown): BusinessProfile {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new BadRequestException('Business profile is required');
  const source = body as Record<string, unknown>;
  const profile = {} as BusinessProfile;
  for (const [key, max] of Object.entries(fields)) {
    const value = source[key];
    if (
      typeof value !== 'string' ||
      value.trim().length > max ||
      hasControlCharacters(value)
    )
      throw new BadRequestException(`Invalid ${key}`);
    profile[key as keyof BusinessProfile] = value.trim();
  }
  profile.country = profile.country.toUpperCase();
  if (profile.country && !/^[A-Z]{2}$/.test(profile.country))
    throw new BadRequestException('Use a two-letter country code');
  return profile;
}

@Injectable()
export class BusinessVerificationService {
  constructor(private readonly prisma: PrismaService) {}

  private async authorize(userId: string, merchantId: string, write = false) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isActive: true },
    });
    if (!user?.isActive)
      throw new UnauthorizedException('Account is not active');
    const membership = await this.prisma.membership.findUnique({
      where: { userId_merchantId: { userId, merchantId } },
      select: { role: true },
    });
    if (!membership || (write && membership.role !== 'OWNER'))
      throw new ForbiddenException('Workspace owner access is required');
  }

  async get(userId: string, merchantId: string) {
    await this.authorize(userId, merchantId);
    return {
      profile: await this.prisma.businessVerification.findUnique({
        where: { merchantId },
      }),
      verificationAvailable: false,
    };
  }

  async save(
    userId: string,
    merchantId: string,
    body: unknown,
    submit: boolean,
  ) {
    await this.authorize(userId, merchantId, true);
    const profile = parseBusinessProfile(body);
    if (submit && Object.values(profile).some((value) => !value))
      throw new BadRequestException(
        'Complete every business field before submitting',
      );
    const status = submit ? 'SUBMITTED' : 'DRAFT';
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.businessVerification.findUnique({
          where: { merchantId },
        });
        if (existing && !['DRAFT', 'ACTION_REQUIRED'].includes(existing.status))
          throw new ConflictException(
            'Submitted profiles cannot be edited until changes are requested',
          );
        if (!existing)
          return tx.businessVerification.create({
            data: {
              merchantId,
              ...profile,
              status,
              submittedAt: submit ? new Date() : null,
            },
          });
        const changed = await tx.businessVerification.updateMany({
          where: { merchantId, status: existing.status },
          data: { ...profile, status, submittedAt: submit ? new Date() : null },
        });
        if (changed.count !== 1)
          throw new ConflictException('Profile changed. Reload and try again');
        return tx.businessVerification.findUniqueOrThrow({
          where: { merchantId },
        });
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      )
        throw new ConflictException('Profile changed. Reload and try again');
      throw error;
    }
  }

  async createWorkspace(userId: string, body: { businessName?: unknown }) {
    const name =
      typeof body?.businessName === 'string' ? body.businessName.trim() : '';
    if (name.length < 2 || name.length > 200 || hasControlCharacters(name))
      throw new BadRequestException('Business name must be 2-200 characters');
    try {
      return await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.findUnique({
          where: { id: userId },
          select: {
            email: true,
            isActive: true,
            externalIdentities: { select: { id: true } },
          },
        });
        if (!user?.isActive || !user.externalIdentities.length)
          throw new ForbiddenException('Social account onboarding is required');
        if (await tx.membership.findFirst({ where: { userId } }))
          throw new ConflictException('Workspace already exists');
        // Social authentication is not merchant approval. No live API key is issued.
        const merchant = await tx.merchant.create({
          data: {
            name,
            email: user.email,
            isActive: false,
            planCode: resolveDefaultMerchantPlanCode(),
            memberships: { create: { userId, role: 'OWNER' } },
          },
          select: { id: true, name: true, isActive: true },
        });
        return { merchant, nextPath: '/dashboard/verification' };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      )
        throw new ConflictException(
          'Workspace already exists or this email is already in use',
        );
      throw error;
    }
  }
}
