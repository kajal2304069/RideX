export type UserRole =
  | "RIDER"
  | "DRIVER"
  | "VEHICLE_OWNER"
  | "GARAGE_OWNER"
  | "MECHANIC"
  | "SELLER"
  | "BUYER"
  | "ADMIN";

export interface UserRecord {
  id: string;
  email: string;
  phone: string | null;
  password_hash: string;
  full_name: string;
  roles: UserRole[];
  is_active: boolean;
  email_verified_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** Never send password_hash to the client. This is what controllers return instead. */
export interface PublicUser {
  id: string;
  email: string;
  phone: string | null;
  fullName: string;
  roles: UserRole[];
  createdAt: Date;
}

export function toPublicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    email: user.email,
    phone: user.phone,
    fullName: user.full_name,
    roles: user.roles,
    createdAt: user.created_at,
  };
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}
