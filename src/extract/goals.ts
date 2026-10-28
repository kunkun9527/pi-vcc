import type { NormalizedBlock } from "../types";
import { nonEmptyLines, clip } from "../core/content";
import { collapseSkillLines } from "../core/skill-collapse";

const SCOPE_CHANGE_RE =
  /\b(instead|actually|change of plan|forget that|new task|switch to|now I want|pivot|let'?s do|stop .* and)\b|(?:改为|改成|换成|改用|不再|重新|先别|别再|现在(?:要|想)|切换到|换个方案)/i;

const TASK_RE =
  /\b(fix|implement|add|create|build|refactor|debug|investigate|update|remove|delete|migrate|deploy|test|write|set up)\b|(?:修复|实现|添加|创建|构建|重构|调试|调查|更新|移除|删除|迁移|部署|测试|编写|设置|排查|优化|修改|改进|解决)/i;

const NOISE_SHORT_RE = /^(ok|yes|no|sure|yeah|yep|go|hi|hey|thx|thanks|ok\b.*|y|n|k)\s*[.!?]*$/i;

// Reject lines that are clearly not user goals (pasted output, code, paths, tool dumps)
// or meta-prompt boilerplate (command templates like `/issues` that start with "For each issue:"
// followed by numbered "Read the issue in full..." steps).
const NON_GOAL_RE =
  /^\s*[\[│├└─╭╰]|```|^\s*(=[A-Z]+\(|function |const |let |var |import |export |class )|^(https?:|file:|\/[A-Za-z])|\\n|^\s*For each\b|\bin full\b[^\n]*\b(comments|issue|issues|PRs?|linked)\b/;

// Signals that the rest of the user message is a command template (e.g. /issues),
// in which case we should stop collecting goals at the signal line.
const TEMPLATE_SIGNAL_RE =
  /^\s*(For each\b|Do NOT implement\b|Analyze and propose\b|If Task\/context\b|Output:\s*$)/i;

const truncateAtTemplate = (lines: string[]): string[] => {
  const idx = lines.findIndex((l) => TEMPLATE_SIGNAL_RE.test(l));
  return idx >= 0 ? lines.slice(0, idx) : lines;
};

const stripLeadingBullet = (line: string): string =>
  line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "").trim();

const MAX_GOAL_CHARS = 200;

const isSubstantiveGoal = (text: string): boolean => {
  const t = text.trim();
  // A short explicit CJK command such as 修复登录 is a substantive goal.
  if (t.length <= 5 && !(t.length >= 3 && /\p{Script=Han}/u.test(t) && TASK_RE.test(t))) return false;
  if (t.length > MAX_GOAL_CHARS) return false;
  if (NOISE_SHORT_RE.test(t)) return false;
  if (NON_GOAL_RE.test(t)) return false;
  return true;
};

// Test scope-change / task intent only on the leading portion of a user block
// so that pasted outputs below the actual instruction do not trigger matches.
const LEADING_CHARS = 200;

export const extractGoals = (blocks: NormalizedBlock[]): string[] => {
  const goals: string[] = [];
  let latestScopeChange: string[] | null = null;

  for (const b of blocks) {
    if (b.kind !== "user") continue;
    const rawLines = nonEmptyLines(b.text);
    const truncated = truncateAtTemplate(rawLines);
    const lines = collapseSkillLines(truncated.filter(isSubstantiveGoal))
      .map(stripLeadingBullet)
      .filter((l) => l.length > 5 || (l.length >= 3 && /\p{Script=Han}/u.test(l) && TASK_RE.test(l)));
    if (lines.length === 0) continue;

    if (goals.length === 0) {
      goals.push(...lines.slice(0, 6));
      continue;
    }

    const leading = b.text.slice(0, LEADING_CHARS);
    if (SCOPE_CHANGE_RE.test(leading)) {
      latestScopeChange = lines.slice(0, 3).map((l) => clip(l, MAX_GOAL_CHARS));
    } else if (TASK_RE.test(leading) && (lines[0].length > 15 || /\p{Script=Han}/u.test(lines[0]))) {
      latestScopeChange = lines.slice(0, 2).map((l) => clip(l, MAX_GOAL_CHARS));
    }
  }

  // Only emit the [Scope change] marker when we actually captured bullets.
  if (latestScopeChange && latestScopeChange.length > 0) {
    goals.push("[Scope change]", ...latestScopeChange);
  }

  return goals.slice(0, 8);
};
