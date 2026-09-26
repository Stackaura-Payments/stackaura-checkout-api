import { Test, TestingModule } from '@nestjs/testing';
import { AgentRegistry } from '../agents/agent.registry';
import { ToolRegistry } from '../tools/tool.registry';
import { PlannerService } from './planner.service';

describe('PlannerService', () => {
  let service: PlannerService;
  const agentRegistry = { get: jest.fn(), list: jest.fn() };
  const toolRegistry = { get: jest.fn(), list: jest.fn() };

  const context = {
    identity: { ownerId: 'owner-1', userId: 'user-1' },
    resource: { type: 'owner', id: 'owner-1' },
  } as any;

  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.GEMINI_API_KEY = 'test-key';
    agentRegistry.list.mockReturnValue([
      { id: 'chief-of-staff', scope: 'owner', name: 'Chief', description: 'Coordinate', capabilities: [], enabled: true },
      { id: 'engineering', scope: 'owner', name: 'Engineering', description: 'Engineering', capabilities: [], enabled: true },
      { id: 'vercel', scope: 'owner', name: 'Vercel', description: 'Vercel', capabilities: [], enabled: true },
    ]);
    agentRegistry.get.mockImplementation((agentId: string) => ({ id: agentId, enabled: true, scope: 'owner' }));
    toolRegistry.list.mockReturnValue([
      { id: 'jarvis.owner.vercel.deployment-status', name: 'Vercel Deployment Status', description: 'Read deployment status', permission: 'owner-observe', readOnly: true, scope: 'owner' },
      { id: 'jarvis.owner.github.repository-status', name: 'GitHub Repository Status', description: 'Read repository status', permission: 'owner-observe', readOnly: true, scope: 'owner' },
    ]);
    toolRegistry.get.mockImplementation((toolId: string) => toolId === 'jarvis.owner.vercel.deployment-status' || toolId === 'jarvis.owner.github.repository-status' ? ({ id: toolId, scope: 'owner' }) : undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlannerService,
        { provide: AgentRegistry, useValue: agentRegistry },
        { provide: ToolRegistry, useValue: toolRegistry },
      ],
    }).compile();
    service = module.get<PlannerService>(PlannerService);
  });

  afterEach(() => {
    delete process.env.GEMINI_API_KEY;
    jest.restoreAllMocks();
  });

  it('accepts a structured LLM plan and validates its registered tool', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({
        goal: 'Check the latest Stackaura deployment.',
        agent: 'vercel',
        steps: [{ toolId: 'jarvis.owner.vercel.deployment-status', intent: 'inspect-deployment' }],
      }) }] } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const plan = await service.plan('Check the latest Stackaura deployment.', context);

    expect(plan).toEqual({
      goal: 'Check the latest Stackaura deployment.',
      agent: 'vercel',
      steps: [{ toolId: 'jarvis.owner.vercel.deployment-status', intent: 'inspect-deployment' }],
    });
  });

  it('rejects an LLM-selected tool that is not registered', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({
        goal: 'Do something unsafe.',
        agent: 'engineering',
        steps: [{ toolId: 'not-a-real-tool', intent: 'execute' }],
      }) }] } }],
    }), { status: 200 }));

    await expect(service.plan('Do something unsafe.', context)).rejects.toThrow(
      'selected unregistered tool',
    );
  });

  it('fails closed when the LLM credential is absent', async () => {
    delete process.env.GEMINI_API_KEY;
    const isolated = new PlannerService(agentRegistry as any, toolRegistry as any);

    await expect(isolated.plan('Check status.', context)).rejects.toThrow(
      'GEMINI_API_KEY',
    );
  });
});
