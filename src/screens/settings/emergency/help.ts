/**
 * The help of the emergency key, "Cómo funciona" (CE-8; design §10, §3.8.5,
 * §3.8.7, §7.5 and §7.6): what it does, the empty account, what it does not
 * do, and the warning to a trusted contact. Each line is a key of the
 * `emergency` area, so its contract (emergency.test.ts) checks the help as
 * it checks the rest: the same in es, en and pt, nothing of what §11.7
 * never promises, and no legal note (CE-D7).
 */
export interface HelpSection {
  title: string;
  items: readonly string[];
}

export const HELP: readonly HelpSection[] = [
  {
    title: 'emergency.help.does',
    items: ['emergency.help.doesErase', 'emergency.help.doesDisk', 'emergency.help.doesKeeps', 'emergency.help.doesCode'],
  },
  {
    title: 'emergency.help.empty',
    items: [
      'emergency.help.emptyOpens',
      'emergency.help.emptyPassphrase',
      'emergency.help.emptyChange',
      'emergency.help.emptyMeans',
      'emergency.help.emptyBack',
    ],
  },
  {
    title: 'emergency.help.limits',
    items: [
      'emergency.help.onlyUnlock',
      'emergency.help.copies',
      'emergency.help.leftovers',
      'emergency.help.notTheirs',
      'emergency.help.forensic',
      'emergency.help.oldCopy',
      'emergency.help.notifications',
      'emergency.help.tor',
      'emergency.help.otherDevices',
      'emergency.help.phone',
    ],
  },
  {
    title: 'emergency.help.alert',
    items: [
      'emergency.help.alertOptional',
      'emergency.help.alertTells',
      'emergency.help.alertNetwork',
      'emergency.help.alertWeek',
      'emergency.help.alertWhen',
      'emergency.help.alertFalse',
    ],
  },
];
