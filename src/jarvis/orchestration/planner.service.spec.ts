import { Test, TestingModule } from '@nestjs/testing';
import { AgentRegistry } from '../agents/agent.registry';
import { ToolRegistry } from '../tools/tool.registry';
import { PlannerService } from './planner.service';

describe('PlannerService', () => {
  let service: PlannerService;
  const agentRegistry = { get: jest.fn() };
  const toolRegistry = { get: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    agentRegistry.get.mockImplementation((agentId: string) => ({ id: agentId, enabled: true }));
    toolRegistry.get.mockImplementation((toolId: string) => ({ id: toolId }));
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlannerService,
        { provide: AgentRegistry, useValue: agentRegistry },
        { provide: ToolRegistry, useValue: toolRegistry },
      ],
    }).compile();
    service = module.get<PlannerService>(PlannerService);
  });

  it('routes a deployment status request to the Vercel owner tool', () => {
    const plan = service.plan('Check the latest Stackaura deployment.');
    expect(plan.agent).toBe('vercel');
    expect(plan.steps).toEqual([
      {
        toolId: 'jarvis.owner.vercel.deployment-status',
        intent: 'inspect-deployment',
      },
    ]);
  });

  it('routes a repository status request to the GitHub owner tool', () => {
    const plan = service.plan('Check the status of Stackaura-Payments/stackaura-checkout-api');
    expect(plan.agent).toBe('github');
    expect(plan.steps).toEqual([
      {
        toolId: 'jarvis.owner.github.repository-status',
        intent: 'inspect-repository',
        arguments: { repositoryFullName: 'Stackaura-Payments/stackaura-checkout-api' },
      },
    ]);
  });

  it('does not route an ordinary status request to GitHub', () => {
    const plan = service.plan('What is the current Stackaura status?');
    expect(plan.agent).toBe('chief-of-staff');
    expect(plan.steps).toEqual([{ toolId: 'command-center.overview', intent: 'status' }]);
  });
});
