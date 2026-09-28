'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('wallet_txs', {
      id: {
        type: Sequelize.UUID,
        primaryKey: true,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
      },
      wallet_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'wallets', key: 'id' },
        onDelete: 'CASCADE',
      },
      funding_tx_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'funding_transactions', key: 'id' },
        onDelete: 'SET NULL',
      },
      type: { type: Sequelize.STRING(32), allowNull: false },
      amount: { type: Sequelize.DECIMAL(36, 18), allowNull: false },
      direction: { type: Sequelize.STRING(8), allowNull: false },
      balance_after: { type: Sequelize.DECIMAL(36, 18), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });

    await queryInterface.addIndex('wallet_txs', ['wallet_id'], { name: 'idx_wallet_txs_wallet_id' });
    await queryInterface.addIndex('wallet_txs', ['funding_tx_id'], { name: 'idx_wallet_txs_funding_tx_id' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('wallet_txs');
  },
};
