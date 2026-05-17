import { describe, it, expect } from 'vitest';
import { KafkaProducerService } from './kafka-producer.service';

/**
 * REVIEW-FINAL Q1 regression test — emitRaw forwards tenant-subdomain
 * as a Kafka transport header.
 *
 * `unwrapEnvelope()` in `notification-consumer-base.ts` requires the
 * legacy `tenant-subdomain` header (it returns null and drops the
 * event when the header is missing). Outbox-published events MUST
 * carry this header or downstream consumers like the emergency-alert
 * fan-out will silently discard them.
 *
 * This test directly exercises the producer's `emitRaw` path with a
 * fake kafkajs producer to capture the headers it actually emits.
 */
describe('KafkaProducerService.emitRaw — tenant-subdomain header propagation', () => {
  it('sets tenant-subdomain when supplied via the new tenantSubdomain option', async () => {
    const sent: Array<{ topic: string; messages: Array<{ headers: Record<string, string> }> }> = [];
    const fakeProducer = {
      send: async (args: {
        topic: string;
        messages: Array<{ headers: Record<string, string> }>;
      }) => {
        sent.push(args);
      },
    };
    const svc = new KafkaProducerService();
    // Simulate the boot path having connected.
    (svc as unknown as { producer: typeof fakeProducer }).producer = fakeProducer;
    (svc as unknown as { connected: boolean }).connected = true;

    await svc.emitRaw({
      topic: 'dev.msg.emergency.issued',
      key: 'alert-1',
      envelope: {
        event_id: '019dff45-1234-7000-8000-000000000001',
        event_type: 'msg.emergency.issued',
        tenant_id: '019dff45-1234-7000-8000-000000000002',
        payload: {},
      },
      tenantSubdomain: 'demo',
    });

    expect(sent).toHaveLength(1);
    const headers = sent[0]!.messages[0]!.headers;
    expect(headers['event-id']).toBe('019dff45-1234-7000-8000-000000000001');
    expect(headers['event-type']).toBe('msg.emergency.issued');
    expect(headers['tenant-id']).toBe('019dff45-1234-7000-8000-000000000002');
    expect(headers['tenant-subdomain']).toBe('demo');
  });

  it('omits tenant-subdomain when not supplied (back-compat with DLQ replay)', async () => {
    const sent: Array<{ messages: Array<{ headers: Record<string, string> }> }> = [];
    const fakeProducer = {
      send: async (args: { messages: Array<{ headers: Record<string, string> }> }) => {
        sent.push(args);
      },
    };
    const svc = new KafkaProducerService();
    (svc as unknown as { producer: typeof fakeProducer }).producer = fakeProducer;
    (svc as unknown as { connected: boolean }).connected = true;

    await svc.emitRaw({
      topic: 'dev.test',
      key: null,
      envelope: {
        event_id: '019dff45-1234-7000-8000-000000000001',
        event_type: 'test.replay',
        tenant_id: '019dff45-1234-7000-8000-000000000002',
        payload: {},
      },
    });

    const headers = sent[0]!.messages[0]!.headers;
    expect(headers['tenant-subdomain']).toBeUndefined();
  });

  it('explicit headers parameter merges on top of derived headers', async () => {
    const sent: Array<{ messages: Array<{ headers: Record<string, string> }> }> = [];
    const fakeProducer = {
      send: async (args: { messages: Array<{ headers: Record<string, string> }> }) => {
        sent.push(args);
      },
    };
    const svc = new KafkaProducerService();
    (svc as unknown as { producer: typeof fakeProducer }).producer = fakeProducer;
    (svc as unknown as { connected: boolean }).connected = true;

    await svc.emitRaw({
      topic: 'dev.test',
      key: null,
      envelope: {
        event_id: 'envelope-event-id',
        event_type: 'test.headers-override',
        tenant_id: '019dff45-1234-7000-8000-000000000002',
        payload: {},
      },
      headers: { 'x-replay-source': 'dlq', 'event-id': 'header-override-event-id' },
    });

    const headers = sent[0]!.messages[0]!.headers;
    expect(headers['x-replay-source']).toBe('dlq');
    // Explicit header wins over derived-from-envelope.
    expect(headers['event-id']).toBe('header-override-event-id');
  });
});
