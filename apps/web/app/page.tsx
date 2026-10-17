import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE } from '@/lib/server';
import Dashboard from '@/components/Dashboard';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const jar = await cookies();
  if (!jar.get(SESSION_COOKIE)?.value) redirect('/login');
  return <Dashboard />;
}
