import { AgentRegistry } from './agent.registry';

describe('AgentRegistry', () => {
  const registry = new AgentRegistry();

  it('registers the four owner integration agents', () => {
    expect(registry.get('github')).toMatchObject({
      id: 'github',
      scope: 'owner',
      enabled: true,
    });
    expect(registry.get('vercel')).toMatchObject({
      id: 'vercel',
      scope: 'owner',
      enabled: true,
    });
    expect(registry.get('supabase')).toMatchObject({
      id: 'supabase',
      scope: 'owner',
      enabled: true,
    });
    expect(registry.get('shopify-owner')).toMatchObject({
      id: 'shopify-owner',
      scope: 'owner',
      enabled: true,
    });
  });

  it('keeps merchant operational agents merchant-scoped', () => {
    expect(registry.get('payments')?.scope).toBe('merchant');
    expect(registry.get('finance')?.scope).toBe('merchant');
    expect(registry.get('support')?.scope).toBe('merchant');
  });

  it('exposes capabilities without exposing credentials or mutable permissions', () => {
    for (const agent of registry.list()) {
      expect(agent).not.toHaveProperty('token');
      expect(agent).not.toHaveProperty('secret');
      expect(agent).not.toHaveProperty('credentials');
      expect(agent).not.toHaveProperty('mutation');
    }
  });
});
