import { Model } from "@mahiframework/database";

export interface UserAttributes {
  id: string;
  email: string;
  password: string;
}

export type UserTable = UserAttributes;

/**
 * A stand-in for the app-owned `User` model, for tests that resolve a
 * real `DatabaseUserProvider` through config rather than stubbing the
 * provider interface.
 */
export class User extends Model<UserAttributes>()({
  table: "users",
  primaryKey: "id",
  timestamps: false,
}) {}
