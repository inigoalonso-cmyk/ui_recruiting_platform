# Pre-screening Platform

App interna para definir, por cada puesto de trabajo, qué parámetros se evalúan y con qué peso (sobre 10), además de las "killer questions" para la fase de entrevista con agente. El workflow de Happy Robot consulta esta app para saber qué evaluar, y le devuelve el score, que esta app sincroniza con Ashby.

## Estructura

```
server.js              -> servidor Express
db/index.js            -> esquema SQLite (jobs, parameters, killer_questions, score_log)
routes/api.js          -> endpoints de la app
routes/ashby.js         -> cliente de la API de Ashby
public/                -> UI (HTML/CSS/JS, sin build step)
```

## Desplegar en Railway

1. Sube esta carpeta a un repo de GitHub (o usa `railway up` desde la CLI directamente).
2. En Railway: **New Project → Deploy from GitHub repo**.
3. Añade un **Volume** montado en `/data` (para que la base de datos SQLite no se borre en cada redeploy) y define `DATA_DIR=/data` en las variables de entorno.
4. Configura las variables de entorno (ver `.env.example`):
   - `INTERNAL_API_KEY` — clave que Happy Robot enviará en el header `x-api-key`.
   - `ASHBY_API_KEY` — tu API key de Ashby (Ashby → Settings → API).
   - `ASHBY_SCORE_FIELD_ID` — id del custom field en Ashby donde se guarda el score (créalo en Ashby y usa `customField.list` para obtener su id, o cópialo desde la propia UI de Ashby si lo muestra).
   - `ASHBY_SCORE_OBJECT_TYPE` — `Application` o `Candidate`, según en qué tipo de objeto hayáis creado el custom field.
5. Railway detecta el proyecto Node automáticamente (Nixpacks) y ejecuta `npm install && npm start`.

## Cómo la usa Happy Robot

### 1. Leer los criterios de un puesto antes de evaluar a un candidato

```
GET https://TU-APP.up.railway.app/api/jobs/{jobId}/evaluation-config
Header: x-api-key: <INTERNAL_API_KEY>
```

Devuelve:
```json
{
  "job": { "id": "...", "name": "Field Engineer", "ashby_job_id": "..." },
  "general_parameters": [{ "name": "Disponibilidad inmediata", "weight": 2, "added_by": "Jorge" }],
  "job_parameters": [{ "name": "Años de experiencia en campo", "weight": 4, "added_by": "Iñigo" }],
  "killer_questions": [{ "question": "¿Puedes viajar más del 50% del tiempo?", "added_by": "Jackson" }]
}
```

Con esto el prompt del agente de pre-screening construye su lista de criterios y pesos.

### 2. Enviar el score calculado (y sincronizarlo con Ashby)

```
POST https://TU-APP.up.railway.app/api/candidates/score
Header: x-api-key: <INTERNAL_API_KEY>
Body:
{
  "job_id": "...",
  "ashby_candidate_id": "...",
  "ashby_application_id": "...",
  "score": 8.5,
  "status": "PASS",
  "breakdown": { "...": "..." },
  "sync_to_ashby": true
}
```

La app guarda el resultado en `score_log` y, si `sync_to_ashby` es `true`, llama a `customField.setValue` en Ashby para escribir el score directamente en el custom field configurado.

### 3. Para el segundo workflow (killer questions)

El agente de la llamada de entrevista puede pedir las killer questions del puesto con el mismo endpoint `evaluation-config` (campo `killer_questions`), o crear un endpoint dedicado más adelante si necesitáis algo distinto (por ejemplo, marcar cuál se usó en cada llamada).

## Notas

- Los "pesos" son libres por diseño (cada persona añade el suyo); la UI muestra la suma total para detectar si os pasáis de 10 entre todos, pero no lo bloquea — decidid vosotros si normalizar o no antes de que el agente calcule el score final.
- No hay autenticación de usuario en la UI (pensada para uso interno del equipo). Si la vais a dejar pública en Railway, al menos añadid algo de auth básica delante (Railway lo permite fácilmente) para que no cualquiera pueda tocar los parámetros.
- Datos protegidos: la UI no impide que alguien añada un parámetro discriminatorio (edad, etc.) — esa validación tiene que vivir en el prompt del agente y en la revisión humana del equipo, ver conversación sobre este punto.
