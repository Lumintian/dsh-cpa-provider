import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveEndpoints } from '../src/endpoints.ts'

test('plain origin gets /v1 for inference and the rich catalog URL', () => {
  const endpoints = resolveEndpoints('http://127.0.0.1:8317')
  assert.equal(endpoints.root, 'http://127.0.0.1:8317')
  assert.equal(endpoints.inferenceBaseUrl, 'http://127.0.0.1:8317/v1')
  assert.equal(endpoints.modelsUrl, 'http://127.0.0.1:8317/v1/models?client_version=dsh')
})

test('scheme is optional and /v1, /backend-api, trailing slashes are normalized', () => {
  assert.equal(resolveEndpoints('127.0.0.1:8317').root, 'http://127.0.0.1:8317')
  assert.equal(resolveEndpoints('https://cpa.example.com/v1/').root, 'https://cpa.example.com')
  assert.equal(resolveEndpoints('https://cpa.example.com/backend-api').root, 'https://cpa.example.com')
  assert.equal(resolveEndpoints('https://cpa.example.com/proxy').inferenceBaseUrl, 'https://cpa.example.com/proxy/v1')
})

test('query, fragment, credentials, and other schemes are rejected', () => {
  assert.throws(() => resolveEndpoints(''), /empty/)
  assert.throws(() => resolveEndpoints('http://h/?a=1'), /query/)
  assert.throws(() => resolveEndpoints('http://h/#x'), /fragment/)
  assert.throws(() => resolveEndpoints('http://u:p@h'), /credentials/)
  assert.throws(() => resolveEndpoints('ftp://h'), /http or https/)
})
