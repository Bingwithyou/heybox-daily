export type Account = { account: string; nickname?: string; avatar?: string | null };
export type Accounts = { activeAccount: string | null; accounts: Account[] };
export async function readAccounts(): Promise<Accounts> {
  const response = await fetch("/api/auth/heybox/accounts", { cache: "no-store" });
  if (!response.ok) throw new Error("无法读取账号，请刷新后重试");
  return response.json();
}
