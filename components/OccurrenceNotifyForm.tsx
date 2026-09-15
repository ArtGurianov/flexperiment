"use client";

import NotifyMeForm from "./NotifyMeForm";

// onAlreadyAvailable is optional because an event page has nothing to refresh:
// the checkout dialog re-reads the occurrence it is holding in state, while a
// standalone page's own live fetch is the thing that decided to render this
// form in the first place. Without a handler NotifyMeForm surfaces the conflict
// as an ordinary error, which is the correct outcome there.
export default function OccurrenceNotifyForm({ occurrenceId, onAlreadyAvailable }: { occurrenceId: string; onAlreadyAvailable?: () => void }) {
  return <NotifyMeForm endpoint="/v1/public/occurrence-notifications" intro="Оставьте email — сообщим один раз, когда на эту конкретную дату снова можно будет записаться." submitLabel="Сообщить о появлении места" successText="Запрос сохранён. Сообщим только об этой дате, без рекламы и предложений других событий." consentPurpose="для одного сервисного уведомления о доступности выбранной даты." buildBody={(base) => ({ ...base, occurrence_id: occurrenceId })} onConflict={onAlreadyAvailable} />;
}
