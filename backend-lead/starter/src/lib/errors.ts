export class NotFoundError extends Error {
  constructor(message = 'Resource not found') {
    super(message);
    this.name = 'NotFoundError';
    Object.setPrototypeOf(this, NotFoundError.prototype);
  }
}

export class InsufficientFundsError extends Error {
  constructor(message = 'Insufficient funds') {
    super(message);
    this.name = 'InsufficientFundsError';
    Object.setPrototypeOf(this, InsufficientFundsError.prototype);
  }
}

export interface TurnoverRequirementDetails {
  requiredTurnover: string;
  accruedTurnover: string;
  outstandingTurnover: string;
}

export class TurnoverRequirementError extends Error {
  public readonly requiredTurnover: string;
  public readonly accruedTurnover: string;
  public readonly outstandingTurnover: string;

  constructor(details: TurnoverRequirementDetails) {
    super(
      `Turnover requirement not met. Required: ${details.requiredTurnover}, Accrued: ${details.accruedTurnover}, Outstanding: ${details.outstandingTurnover}`,
    );
    this.name = 'TurnoverRequirementError';
    this.requiredTurnover = details.requiredTurnover;
    this.accruedTurnover = details.accruedTurnover;
    this.outstandingTurnover = details.outstandingTurnover;
    Object.setPrototypeOf(this, TurnoverRequirementError.prototype);
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}
