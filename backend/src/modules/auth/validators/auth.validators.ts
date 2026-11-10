import { z } from "zod";

const ROLE_VALUES = [
  "RIDER",
  "DRIVER",
  "VEHICLE_OWNER",
  "GARAGE_OWNER",
  "MECHANIC",
  "SELLER",
  "BUYER",
  "ADMIN",
] as const;

// ADMIN is deliberately excluded from self-registration - admins are
// promoted by an existing admin (Phase 18), never created by public signup.
const SELF_ASSIGNABLE_ROLES = ROLE_VALUES.filter((r) => r !== "ADMIN") as [string, ...string[]];

export const registerSchema = z.object({
  body: z.object({
    email: z.string().email(),
    password: z
      .string()
      .min(8, "Password must be at least 8 characters")
      .max(128)
      .regex(/[A-Z]/, "Password must contain an uppercase letter")
      .regex(/[a-z]/, "Password must contain a lowercase letter")
      .regex(/[0-9]/, "Password must contain a number"),
    fullName: z.string().min(2).max(100),
    phone: z.string().min(7).max(20).optional(),
    roles: z.array(z.enum(SELF_ASSIGNABLE_ROLES)).min(1).default(["RIDER"]),
  }),
});

export const loginSchema = z.object({
  body: z.object({
    email: z.string().email(),
    password: z.string().min(1, "Password is required"),
  }),
});

export const refreshSchema = z.object({
  body: z.object({
    refreshToken: z.string().min(1).optional(),
  }),
});

export type RegisterInput = z.infer<typeof registerSchema>["body"];
export type LoginInput = z.infer<typeof loginSchema>["body"];
