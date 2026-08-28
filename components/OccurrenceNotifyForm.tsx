"use client";

import NotifyMeForm from "./NotifyMeForm";

export default function OccurrenceNotifyForm({ occurrenceId, onAlreadyAvailable }: { occurrenceId: string; onAlreadyAvailable: () => void }) {
  return <NotifyMeForm endpoint="/v1/public/occurrence-notifications" intro="Оставьте email — сообщим один раз, когда на эту конкретную дату снова можно будет записаться." submitLabel="Сообщить о появлении места" successText="Запрос сохранён. Сообщим только об этой дате, без рекламы и предложений других событий." consentPurpose="для одного сервисного уведомления о доступности выбранной даты." buildBody={(base) => ({ ...base, occurrence_id: occurrenceId })} onConflict={onAlreadyAvailable} />;
}
