import { Transform, Type } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

const trim = (value: unknown) =>
  typeof value === 'string' ? value.trim() : value;
const trimUpper = (value: unknown) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

export class InitiateOzowPaymentDto {
  @IsInt()
  @Min(1)
  amountCents!: number;

  @Transform(({ value }) => trimUpper(value as unknown))
  @IsOptional()
  @IsString()
  @IsIn(['ZAR'])
  currency?: 'ZAR';

  @Transform(({ value }) => trim(value))
  @IsOptional()
  @IsString()
  @MaxLength(50)
  reference?: string;

  @Transform(({ value }) => trim(value))
  @IsOptional()
  @IsString()
  @MaxLength(20)
  bankReference?: string;

  @Transform(({ value }) => trim(value))
  @IsOptional()
  @IsEmail()
  @MaxLength(100)
  customerEmail?: string;

  @Transform(({ value }) => trim(value))
  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;
}

export class PublicOzowSignupDto {
  @Transform(({ value }) => trim(value))
  @IsString()
  @MaxLength(120)
  businessName!: string;

  @Transform(({ value }) => trim(value))
  @IsEmail()
  @MaxLength(100)
  email!: string;

  @Transform(({ value }) => trim(value))
  @IsString()
  @MinLength(6)
  @MaxLength(255)
  password!: string;

  @Transform(({ value }) => trim(value))
  @IsOptional()
  @IsString()
  @MaxLength(100)
  country?: string;
}

export class PublicOzowReturnUrlsDto {
  @Transform(({ value }) => trim(value))
  @IsOptional()
  @IsUrl()
  @MaxLength(255)
  success?: string;

  @Transform(({ value }) => trim(value))
  @IsOptional()
  @IsUrl()
  @MaxLength(255)
  cancel?: string;

  @Transform(({ value }) => trim(value))
  @IsOptional()
  @IsUrl()
  @MaxLength(255)
  error?: string;
}

export class PublicOzowSignupInitiateDto {
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString()
  @IsIn(['merchant_signup'])
  flow!: 'merchant_signup';

  @Type(() => PublicOzowSignupDto)
  @ValidateNested()
  signup!: PublicOzowSignupDto;

  @Type(() => PublicOzowReturnUrlsDto)
  @IsOptional()
  @ValidateNested()
  returnUrls?: PublicOzowReturnUrlsDto;

  @IsOptional()
  @IsInt()
  @Min(1)
  amountCents?: number;

  @Transform(({ value }) => trimUpper(value as unknown))
  @IsOptional()
  @IsString()
  @IsIn(['ZAR'])
  currency?: 'ZAR';

  @Transform(({ value }) => trim(value))
  @IsOptional()
  @IsString()
  @MaxLength(50)
  reference?: string;
}
