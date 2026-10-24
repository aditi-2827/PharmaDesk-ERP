import { requireOwnerPage } from "@/lib/authorization";
import { db } from "@/db";
import { users } from "@/db/schema";
import { UsersClient } from "./client-page";
import { desc } from "drizzle-orm";

export default async function UsersPage() {
  const currentUser = await requireOwnerPage();

  const allUsers = await db.query.users.findMany({
    orderBy: [desc(users.createdAt)],
  });

  return <UsersClient initialUsers={allUsers} currentUserEmail={currentUser.email} />;
}

