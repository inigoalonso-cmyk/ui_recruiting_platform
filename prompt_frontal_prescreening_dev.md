# Prompt para la IA de HappyRobot — configurar el workflow "Prescreening Dev"

> Pégalo tal cual en la IA de la plataforma (frontal), con el workflow **`Prescreening Dev`** abierto. Está redactado como instrucción directa para el agente que edita el workflow.

---

## Contexto

`Prescreening Dev` (slug `s7tv6b29ya03`) es **una copia exacta** del workflow de producción `Prescreening`. Hoy hace un batch programado: cron cada 5 min → lee candidatos de un simulador de Ashby → por cada candidato lo puntúa con un agente LLM → escribe el resultado en el simulador.

Quiero convertir ESTA copia en un **sandbox manual de un solo CV**: se dispara por webhook desde mi dashboard, puntúa **un único CV que llega como texto** con **el mismo agente de scoring** (sin cambiarlo), añade un desglose por criterio, y **escribe el resultado en mi dashboard** (nunca en Ashby).

## Reglas de oro (CRÍTICAS, no las incumplas)

1. **Edita SOLO el workflow `Prescreening Dev`.** No toques el workflow de producción `Prescreening` bajo ningún concepto.
2. **No cambies el razonamiento del agente de scoring** (`Evaluate Applicant Fit Details`): ni su prompt, ni el modelo (`gpt-4.1`), ni sus variables de entrada, ni los campos de salida `score`/`rationale`. La nota debe salir **idéntica** a producción. Lo ÚNICO que se le añade es un campo de salida nuevo (ver paso 5).
3. **En este workflow NO se llama nunca a Ashby / al simulador.** La única escritura externa es el POST a mi dashboard (paso 6).

## Estado final que quiero (grafo lineal)

```
[Trigger Webhook] → [Fetch Evaluation Config] → [Format Criteria and Candidate] → [Evaluate Applicant Fit Details] → [Submit Prescreen Result → dashboard]
```

Todo lo demás del batch original sobra y debe quedar **fuera del camino de ejecución**: `List Candidates`, `Limit Batch`, el `Loop`, `Get Candidate`, `Extract Resume URL`, `Parse Resume` (OCR), la condición `Check Resume URL`, `Fetch Settings`, la condición `Score Threshold Check` y el segundo `Submit Prescreen Result`. Puedes borrarlos o dejarlos desconectados, pero que no se ejecuten.

## Pasos detallados

### 1) Trigger — reemplazar el cron por un Webhook (entrada manual)
- Sustituye el trigger de cron ("Hourly Trigger") por un **trigger de Webhook / petición entrante** (Incoming hook o Predefined request).
- El dashboard le hará un **POST** con este cuerpo JSON:
  ```json
  {
    "run_id": "run_abc123",
    "job_id": "job_abc123",
    "candidate_name": "Jane Doe",
    "cv_text": "Texto plano completo del CV del candidato..."
  }
  ```
- Deja expuestas como variables del trigger: `run_id`, `job_id`, `candidate_name`, `cv_text`.

### 2) Fetch Evaluation Config (HTTP GET) — leer criterios de mi dashboard
- Método: **GET**
- URL: `https://uirecruitingplatform-production.up.railway.app/api/jobs/{{trigger.job_id}}/evaluation-config`
  (usa el `job_id` del trigger; **no** el `job_id` del antiguo `Get Candidate`).
- Header: `x-api-key: {{use_case_variables.INTERNAL_API_KEY}}` (ya lo tiene, mantenlo).
- Devuelve, entre otros: `job_parameters`, `general_parameters`, `weight_total`, y `job.name`.

### 3) Format Criteria and Candidate (nodo de código Python) — NO cambies el código
Deja el código Python **tal cual**. Solo **remapea sus variables de entrada** para que el CV venga del trigger:
- `job_parameters` = `{{Fetch Evaluation Config.job_parameters}}`
- `general_parameters` = `{{Fetch Evaluation Config.general_parameters}}`
- `weight_total` = `{{Fetch Evaluation Config.weight_total}}`
- `profile_text` = `{{trigger.cv_text}}`
- `cv_source` = **(déjalo vacío)** → así el código usa `profile_text` como texto del CV
- `ocr_raw_text` = **(vacío)**
- `candidate_name` = `{{trigger.candidate_name}}`
- `job_title` = `{{Fetch Evaluation Config.job.name}}`

(El código produce `formatted_criteria`, `cv_text`, `candidate_name`, `job_title` para el agente — no cambia.)

### 4) Evaluate Applicant Fit Details (agente de scoring) — casi intacto
- **NO toques**: el prompt, el modelo (`gpt-4.1`), las variables de entrada, ni los outputs `score` y `rationale`.
- Sus entradas siguen viniendo del nodo `Format Criteria and Candidate` (job_title, formatted_criteria, cv_text, candidate_name) — igual que ahora.

### 5) Evaluate Applicant Fit Details — añadir SOLO un output nuevo
Añade al tool de salida del agente **un tercer campo** (sin tocar `score` ni `rationale`):
- Nombre: `parameter_breakdown`
- Tipo: texto (string)
- Descripción: *"After deciding the score, output ONE short line per evaluation criterion: the criterion name, its weight (%), and how well the candidate matched it citing specific evidence from the profile. Must be consistent with the score and rationale you already gave — do NOT change them. Markdown bullet list."*
- Ejemplo: 
  ```
  - Python (30%): 5 yrs backend Python across production services — strong match.
  - AI/ML (25%): no ML frameworks or projects mentioned — weak.
  - Communication (15%): led client demos and wrote docs — good.
  ```

### 6) Submit Prescreen Result (HTTP POST) — escribir en mi dashboard (única escritura)
- Método: **POST**
- URL: `https://uirecruitingplatform-production.up.railway.app/api/jobs/{{trigger.job_id}}/dev/result`
- Headers: `Content-Type: application/json`, `x-api-key: {{use_case_variables.INTERNAL_API_KEY}}`
- Cuerpo (JSON):
  ```json
  {
    "run_id": "{{trigger.run_id}}",
    "candidate_name": "{{trigger.candidate_name}}",
    "score": {{Evaluate Applicant Fit Details.response.score}},
    "rationale": "{{Evaluate Applicant Fit Details.response.rationale}}",
    "parameter_breakdown": "{{Evaluate Applicant Fit Details.response.parameter_breakdown}}"
  }
  ```
- **No** apunta al simulador de Ashby. Solo a mi dashboard.

## Resultado esperado
Al terminar, el workflow debe: recibir el POST del webhook con `{run_id, job_id, candidate_name, cv_text}` → leer criterios de mi dashboard con `job_id` → formatear → puntuar con el agente (misma nota que producción) + generar `parameter_breakdown` → hacer POST del resultado a mi dashboard. Sin tocar Ashby ni el workflow de producción.
