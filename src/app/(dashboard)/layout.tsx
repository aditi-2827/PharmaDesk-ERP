import { SessionProvider } from "next-auth/react";
import { auth } from "@/lib/auth";
import { requireUserPage } from "@/lib/authorization";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireUserPage();
  const session = await auth();

  return (
    <SessionProvider session={session}>
      <div className="min-h-screen bg-surface-50">
        <Sidebar />
        <div className="lg:pl-[260px] transition-all duration-300">
          <Header />
          <main className="p-8">{children}</main>
        </div>
      </div>
    </SessionProvider>
  );
}
