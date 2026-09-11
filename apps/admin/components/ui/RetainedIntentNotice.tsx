"use client";

/**
 * PR-C2 review round 2, P1: the operator-facing half of retained command
 * intent.
 *
 * When a command's outcome is ambiguous, the sanctioned mutation layer keeps
 * the variables it was sent with - the observed version pin included - and
 * refreshes authoritative state. The screen therefore now shows NEWER state
 * than the command was authored against, and the two things the operator
 * might want next are genuinely different commands:
 *
 *   "retry what I sent"      -> replay the retained variables verbatim; the
 *                               server decides, and refuses if something
 *                               legal happened in between
 *   "act on what I see now"  -> discard the snapshot and author a fresh
 *                               command against the refreshed state
 *
 * Only the operator knows which one they mean, so this asks rather than
 * guessing. Renders nothing when there is no retained intent.
 */
export function RetainedIntentNotice({ retained, onRetry, onDiscard, busy }: {
  retained: unknown;
  onRetry: () => void;
  onDiscard: () => void;
  busy?: boolean;
}) {
  if (retained === null || retained === undefined) return null;
  return (
    <div className="notice" role="status">
      <p>
        Предыдущая команда не получила однозначного ответа и могла быть применена.
        Данные на экране уже обновлены, поэтому повторная отправка формы будет
        <strong> новой командой относительно нового состояния</strong>, а не повтором прежней.
      </p>
      <button disabled={busy} onClick={onRetry}>Повторить прежнюю команду</button>
      <button disabled={busy} onClick={onDiscard}>Это новое действие</button>
    </div>
  );
}
