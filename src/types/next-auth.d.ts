import "next-auth";

declare module "next-auth" {
  interface User {
    id: string;
    role: "owner" | "staff";
    name: string;
    email: string;
    sessionVersion: number;
  }

  interface Session {
    user: User & {
      id: string;
      role: "owner" | "staff";
      sessionVersion: number;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    role: "owner" | "staff";
    sessionVersion: number;
  }
}
