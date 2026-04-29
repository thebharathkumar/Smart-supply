{{/* Common labels emitted by every resource. */}}
{{- define "smart-supply.labels" -}}
app.kubernetes.io/name: smart-supply
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version | replace "+" "_" }}
{{- end }}

{{/* Per-component selector. */}}
{{- define "smart-supply.componentSelector" -}}
app.kubernetes.io/name: smart-supply
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{/* Database URL constructed from external secret. */}}
{{- define "smart-supply.databaseUrl" -}}
postgres://$(POSTGRES_USER):$(POSTGRES_PASSWORD)@{{ .Values.postgres.external.host }}:{{ .Values.postgres.external.port }}/{{ .Values.postgres.external.database }}
{{- end }}

{{- define "smart-supply.redisUrl" -}}
redis://{{ .Values.redis.external.host }}:{{ .Values.redis.external.port }}
{{- end }}

{{- define "smart-supply.image" -}}
{{ .Values.global.imageRegistry }}/{{ .repository }}:{{ default .Values.image.tag .tag }}
{{- end }}

{{/* Common pod env: db creds, otel, log level. */}}
{{- define "smart-supply.commonEnv" -}}
- name: POSTGRES_USER
  valueFrom:
    secretKeyRef:
      name: {{ .Values.postgres.external.existingSecret }}
      key: {{ .Values.postgres.external.userKey }}
- name: POSTGRES_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ .Values.postgres.external.existingSecret }}
      key: {{ .Values.postgres.external.passwordKey }}
- name: DATABASE_URL
  value: {{ include "smart-supply.databaseUrl" . | quote }}
- name: REDIS_URL
  value: {{ include "smart-supply.redisUrl" . | quote }}
- name: KAFKA_BROKERS
  value: {{ .Values.kafka.brokers | quote }}
- name: OTEL_EXPORTER_OTLP_ENDPOINT
  value: {{ .Values.observability.otel.endpoint | quote }}
- name: OTEL_DISABLED
  value: "false"
{{- end }}
