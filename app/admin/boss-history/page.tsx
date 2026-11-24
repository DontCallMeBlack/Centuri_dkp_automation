import dynamic from 'next/dynamic';
import LoadingSurface from '@/components/LoadingSurface';

const BossHistoryPanel = dynamic(() => import('@/components/BossHistoryPanel'), {
  loading: () => <LoadingSurface fullLayout label="Opening kill history" title="Kill history" />,
});

export default function BossHistoryPage() {
  return <BossHistoryPanel />;
}
