'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('wallets', 'required_turnover', {
      type: Sequelize.DECIMAL(36, 18),
      allowNull: false,
      defaultValue: '0',
    });

    await queryInterface.addColumn('wallets', 'accrued_turnover', {
      type: Sequelize.DECIMAL(36, 18),
      allowNull: false,
      defaultValue: '0',
    });

    // PostgreSQL check constraint for non-negative balance
    await queryInterface.sequelize.query(
      'ALTER TABLE wallets ADD CONSTRAINT chk_wallets_balance_non_negative CHECK (balance >= 0);'
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      'ALTER TABLE wallets DROP CONSTRAINT IF EXISTS chk_wallets_balance_non_negative;'
    );
    await queryInterface.removeColumn('wallets', 'accrued_turnover');
    await queryInterface.removeColumn('wallets', 'required_turnover');
  },
};
