import { BowArrow, Crown, Flame, HeartHandshake, Leaf, Shield, Snowflake, Sword, Swords, UserRound, Users, WandSparkles } from 'lucide-react';

const ranks = {
  chief: { icon: Crown, tone: 'role-gold', label: 'Chief' },
  general: { icon: Swords, tone: 'role-violet', label: 'General' },
  guardian: { icon: Shield, tone: 'role-cyan', label: 'Guardian' },
  clansman: { icon: UserRound, tone: 'role-slate', label: 'Clansman' },
};
const classes = {
  everyone: { icon: Users, tone: 'role-cyan' },
  ranger: { icon: BowArrow, tone: 'role-gold' },
  'dps rogue': { icon: Sword, tone: 'role-violet' },
  'fire mage': { icon: Flame, tone: 'role-orange' },
  'ice mage': { icon: Snowflake, tone: 'role-cyan' },
  'support druid': { icon: Leaf, tone: 'role-green' },
  'dps druid': { icon: WandSparkles, tone: 'role-violet' },
  'support rogue': { icon: HeartHandshake, tone: 'role-rose' },
  'dps warrior': { icon: Swords, tone: 'role-orange' },
  tank: { icon: Shield, tone: 'role-rose' },
};

export function RoleIcon({ role = '', className = 'h-4 w-4' }: { role?: string; className?: string }) {
  const config = ranks[role.toLowerCase() as keyof typeof ranks];
  const Icon = config?.icon ?? UserRound;
  return <Icon className={className} aria-hidden="true" />;
}

export default function RoleBadge({ role = '', gameClass = false, compact = false, className = '' }: { role?: string; gameClass?: boolean; compact?: boolean; className?: string }) {
  const key = role.trim().replace(/\s+/g, ' ').toLowerCase();
  const config = gameClass ? classes[key as keyof typeof classes] : ranks[key as keyof typeof ranks];
  const Icon = config?.icon ?? UserRound;
  return <span className={`role-badge ${config?.tone ?? 'role-slate'} ${className}`} title={role || 'Unassigned'}><Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />{!compact && <span className="truncate">{role || 'Unassigned'}</span>}</span>;
}
