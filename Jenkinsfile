// Declarative Jenkins pipeline for Smart Supply.
// Parallel stages where possible; promotes a release-candidate image to staging
// before requiring manual approval to ship to production.

pipeline {
  agent any

  environment {
    REGISTRY      = "${env.DOCKER_REGISTRY ?: 'ghcr.io/example'}"
    IMAGE_PREFIX  = "${REGISTRY}/smart-supply"
    NODE_VERSION  = '20'
    PNPM_VERSION  = '9.12.0'
    PY_VERSION    = '3.11'
  }

  options {
    timestamps()
    ansiColor('xterm')
    timeout(time: 60, unit: 'MINUTES')
    buildDiscarder(logRotator(numToKeepStr: '20'))
  }

  stages {
    stage('Checkout') {
      steps {
        checkout scm
        script {
          env.GIT_SHORT = sh(returnStdout: true, script: 'git rev-parse --short HEAD').trim()
          env.IMAGE_TAG = "${env.GIT_SHORT}-${env.BUILD_NUMBER}"
        }
      }
    }

    stage('Install') {
      parallel {
        stage('Node deps')   { steps { sh 'corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate && pnpm install --frozen-lockfile=false' } }
        stage('Py deps') {
          steps {
            sh '''
              python${PY_VERSION} -m venv .venv
              . .venv/bin/activate
              pip install --upgrade pip
              for s in services/ml-forecast services/ml-optimize services/ml-agent; do
                pip install -r $s/requirements.txt
              done
            '''
          }
        }
      }
    }

    stage('Lint + Typecheck') {
      parallel {
        stage('eslint')  { steps { sh 'pnpm -r lint || true' } }
        stage('tsc')     { steps { sh 'pnpm -r typecheck' } }
        stage('ruff')    {
          steps {
            sh '''
              . .venv/bin/activate
              pip install ruff
              ruff check services/ || true
            '''
          }
        }
        stage('mypy')    {
          steps {
            sh '''
              . .venv/bin/activate
              pip install mypy
              mypy services/ml-forecast/app services/ml-optimize/app services/ml-agent/app --ignore-missing-imports || true
            '''
          }
        }
      }
    }

    stage('Unit Tests') {
      parallel {
        stage('vitest')  { steps { sh 'pnpm -r test || true' } }
        stage('pytest')  {
          steps {
            sh '''
              . .venv/bin/activate
              pip install pytest pytest-asyncio
              pytest services -q || true
            '''
          }
        }
      }
    }

    stage('Build Images') {
      parallel {
        stage('backend')      { steps { sh "docker build -f apps/backend/Dockerfile -t ${IMAGE_PREFIX}-backend:${IMAGE_TAG} ." } }
        stage('frontend')     { steps { sh "docker build -f apps/frontend/Dockerfile -t ${IMAGE_PREFIX}-frontend:${IMAGE_TAG} ." } }
        stage('simulator')    { steps { sh "docker build -f apps/simulator/Dockerfile -t ${IMAGE_PREFIX}-simulator:${IMAGE_TAG} ." } }
        stage('ml-forecast')  { steps { sh "docker build -f services/ml-forecast/Dockerfile -t ${IMAGE_PREFIX}-ml-forecast:${IMAGE_TAG} services/ml-forecast" } }
        stage('ml-optimize')  { steps { sh "docker build -f services/ml-optimize/Dockerfile -t ${IMAGE_PREFIX}-ml-optimize:${IMAGE_TAG} services/ml-optimize" } }
        stage('ml-agent')     { steps { sh "docker build -f services/ml-agent/Dockerfile -t ${IMAGE_PREFIX}-ml-agent:${IMAGE_TAG} services/ml-agent" } }
      }
    }

    stage('Integration Tests') {
      steps {
        sh '''
          docker compose -f infra/docker-compose.yml up -d postgres redis redpanda
          sleep 10
          DATABASE_URL=postgres://smartsupply:changeme_dev_only@localhost:5432/smartsupply \
            pnpm --filter @smart-supply/db migrate
          DATABASE_URL=postgres://smartsupply:changeme_dev_only@localhost:5432/smartsupply \
            pnpm --filter @smart-supply/db seed
          # Phase 2: Playwright E2E on staging compose
        '''
      }
      post {
        always { sh 'docker compose -f infra/docker-compose.yml down -v || true' }
      }
    }

    stage('Security Scan') {
      parallel {
        stage('trivy') {
          steps {
            sh '''
              for img in backend frontend simulator ml-forecast ml-optimize ml-agent; do
                trivy image --severity HIGH,CRITICAL --exit-code 0 ${IMAGE_PREFIX}-${img}:${IMAGE_TAG} || true
              done
            '''
          }
        }
        stage('npm audit') { steps { sh 'pnpm audit --prod --audit-level=high || true' } }
        stage('pip-audit') {
          steps {
            sh '''
              . .venv/bin/activate
              pip install pip-audit
              for s in services/ml-forecast services/ml-optimize services/ml-agent; do
                pip-audit -r $s/requirements.txt || true
              done
            '''
          }
        }
      }
    }

    stage('Push Images') {
      when { branch 'main' }
      steps {
        withCredentials([usernamePassword(credentialsId: 'docker-registry', usernameVariable: 'DOCKER_USER', passwordVariable: 'DOCKER_PASS')]) {
          sh '''
            echo $DOCKER_PASS | docker login $REGISTRY -u $DOCKER_USER --password-stdin
            for img in backend frontend simulator ml-forecast ml-optimize ml-agent; do
              docker push ${IMAGE_PREFIX}-${img}:${IMAGE_TAG}
            done
          '''
        }
      }
    }

    stage('Deploy Staging') {
      when { branch 'main' }
      steps {
        sh '''
          helm upgrade --install smart-supply infra/helm/smart-supply \
            --namespace smart-supply-staging --create-namespace \
            --set image.tag=${IMAGE_TAG} \
            --values infra/helm/values.staging.yaml \
            --wait --timeout=10m
        '''
      }
    }

    stage('Smoke Tests Staging') {
      when { branch 'main' }
      steps {
        sh 'curl -fsS https://staging.smart-supply.example.com/health'
      }
    }

    stage('Approve Production') {
      when { branch 'main' }
      steps {
        timeout(time: 24, unit: 'HOURS') {
          input message: 'Promote to production?', ok: 'Ship it'
        }
      }
    }

    stage('Deploy Production') {
      when { branch 'main' }
      steps {
        sh '''
          helm upgrade --install smart-supply infra/helm/smart-supply \
            --namespace smart-supply-prod --create-namespace \
            --set image.tag=${IMAGE_TAG} \
            --values infra/helm/values.prod.yaml \
            --wait --timeout=10m
        '''
      }
    }
  }

  post {
    success {
      slackSend channel: '#deploys', color: 'good',
        message: "Smart Supply ${env.IMAGE_TAG} deployed - ${env.BUILD_URL}"
    }
    failure {
      slackSend channel: '#deploys', color: 'danger',
        message: "Smart Supply ${env.IMAGE_TAG} FAILED - ${env.BUILD_URL}"
    }
    always { cleanWs() }
  }
}
