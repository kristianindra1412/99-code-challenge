import { DataTypes, Model, Sequelize } from 'sequelize';

export class Member extends Model {
  declare id: string;
  declare username: string;
}

export function initMember(sequelize: Sequelize): void {
  Member.init(
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      username: { type: DataTypes.STRING, allowNull: false, unique: true },
    },
    { sequelize, tableName: 'members', underscored: true },
  );
}
