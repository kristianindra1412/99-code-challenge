'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('funding_transactions', {
      id: {
        type: Sequelize.UUID,
        primaryKey: true,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
      },
      member_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'members', key: 'id' },
        onDelete: 'CASCADE',
      },
      type: { type: Sequelize.STRING(32), allowNull: false },
      amount: { type: Sequelize.DECIMAL(36, 18), allowNull: false },
      status: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'pending' },
      psp_ref: { type: Sequelize.STRING(128), allowNull: false },
      turnover_multiplier: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      failure_reason: { type: Sequelize.TEXT, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });

    await queryInterface.addIndex('funding_transactions', ['member_id'], { name: 'idx_funding_tx_member_id' });
    await queryInterface.addIndex('funding_transactions', ['psp_ref'], { unique: true, name: 'idx_funding_tx_psp_ref' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('funding_transactions');
  },
};
