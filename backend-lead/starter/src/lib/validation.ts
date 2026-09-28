import { z } from 'zod';
import { dec } from './money';

/**
 * Reusable Zod schema validating string decimals for financial transactions.
 *
 * Rules:
 * 1. Must be a string (Zero Floating-Point Rule: never accepts JS numbers).
 * 2. Matches positive decimal format with at most 18 decimal places (PostgreSQL DECIMAL(36,18)).
 * 3. Numerical value must be strictly > 0.
 */
export const positiveAmountSchema = z
  .string({
    required_error: 'amount is required',
    invalid_type_error: 'amount must be a string decimal',
  })
  .regex(/^\d+(\.\d{1,18})?$/, 'amount must be a valid positive decimal string with up to 18 decimal places')
  .refine(
    (val) => {
      try {
        const bn = dec(val);
        return bn.isFinite() && bn.isGreaterThan(0);
      } catch {
        return false;
      }
    },
    {
      message: 'amount must be strictly greater than 0',
    },
  );
