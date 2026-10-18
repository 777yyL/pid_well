const synonyms = [
  ["mqtt", "消息队列遥测传输"],
  ["sso", "单点登录", "统一认证"],
  ["rbac", "角色权限", "基于角色的访问控制"],
  ["ptz", "云台", "云台控制"],
  ["回放", "录像检索", "录像查询"],
  ["广播", "播报", "音频播放"],
  ["告警", "报警", "预警"],
  ["纳管", "统一接入", "集中管理"],
];
export function retrievalTokens(query: string) {
  const lower = query.toLowerCase();
  const expanded = [
    lower,
    ...synonyms.filter((group) => group.some((s) => lower.includes(s))).flat(),
  ];
  const terms = [
    ...new Set(expanded.flatMap((s) => s.match(/[\p{L}\p{N}]+/gu) ?? [])),
  ];
  return [
    ...new Set(
      terms.flatMap((t) =>
        /[\u3400-\u9fff]/.test(t) && t.length > 2
          ? [
              t,
              ...Array.from({ length: t.length - 1 }, (_, i) =>
                t.slice(i, i + 2),
              ),
            ]
          : [t],
      ),
    ),
  ];
}
