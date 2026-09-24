// /gob/observaciones/[publicToken] — el detalle, y el que de verdad importaba.
//
// Es el destino del botón "Cerrar" que `/gob/acciones` le ofrece a un
// funcionario (app/gob/acciones/_lib/worklist-core.ts:148). Hasta hoy apuntaba
// a `/admin/observaciones/[token]`, cuyo layout rebota a gobierno — así que el
// producto ofrecía la acción y después se la negaba, sin decir por qué.
//
// Mismo re-export que la cola: el guard de la página
// (`requireAdminOrGovtOrRedirect`) ya contemplaba este rol, y la acción de
// cierre también. Sólo faltaba la puerta.

export { default } from "@/app/admin/observaciones/[publicToken]/page";
