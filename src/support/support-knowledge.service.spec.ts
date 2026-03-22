import { SupportKnowledgeService } from './support-knowledge.service';

describe('SupportKnowledgeService', () => {
  it('returns gateway setup guidance for gateway-related searches', () => {
    const service = new SupportKnowledgeService();

    const matches = service.search('How do I connect Ozow in the dashboard?');

    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]?.title).toContain('Gateway');
  });
});
