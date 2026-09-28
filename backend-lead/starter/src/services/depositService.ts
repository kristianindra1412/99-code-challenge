import { randomUUID } from 'crypto';
import { dec } from '../lib/money';
import { NotFoundError, ValidationError } from '../lib/errors';
import { Member, FundingTransaction } from '../db/models';

export interface CreateDepositParams {
  memberId: string;
  amount: string;
  turnoverMultiplier?: number;
}

export async function createDeposit(params: CreateDepositParams): Promise<FundingTransaction> {
  if (!params.memberId) {
    throw new ValidationError('memberId is required');
  }

  const bnAmount = dec(params.amount);
  if (bnAmount.isLessThanOrEqualTo(0)) {
    throw new ValidationError('Deposit amount must be positive');
  }

  const turnoverMultiplier = params.turnoverMultiplier ?? 1;
  if (!Number.isInteger(turnoverMultiplier) || turnoverMultiplier < 0) {
    throw new ValidationError('turnoverMultiplier must be an integer >= 0');
  }

  const member = await Member.findByPk(params.memberId);
  if (!member) {
    throw new NotFoundError(`Member not found: ${params.memberId}`);
  }

  const pspRef = `psp_dep_${randomUUID()}`;

  const fundingTx = await FundingTransaction.create({
    memberId: params.memberId,
    type: 'deposit',
    amount: bnAmount.toFixed(18),
    status: 'pending',
    pspRef,
    turnoverMultiplier,
  });

  return fundingTx;
}
