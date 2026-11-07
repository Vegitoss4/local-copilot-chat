import * as assert from 'assert';
import { WhiteboardCoordinator } from '../../src/services/whiteboardCoordinator';

describe('Phase 10.1: Shared Whiteboard Coordination & State Management Suite', () => {
  let whiteboard: WhiteboardCoordinator;

  beforeEach(() => {
    WhiteboardCoordinator.resetInstance();
    whiteboard = WhiteboardCoordinator.getInstance();
  });

  it('should initialize whiteboard state with schema version 3', () => {
    whiteboard.initTask('Implement OAuth callback');
    const state = whiteboard.getState();

    assert.strictEqual(state.version, 3);
    assert.strictEqual(state.userObjective, 'Implement OAuth callback');
    assert.deepStrictEqual(state.modifiedFiles, []);
    assert.deepStrictEqual(state.subtasks, []);
    assert.deepStrictEqual(state.checkpoints, []);
  });

  it('should manage subtasks lifecycle across agents', () => {
    whiteboard.initTask('Refactor auth module');

    whiteboard.addSubtask({
      id: 'sub-1',
      assignedTo: 'architect',
      description: 'Analyze affected auth callers',
      status: 'pending'
    });

    whiteboard.addSubtask({
      id: 'sub-2',
      assignedTo: 'developer',
      description: 'Patch auth methods',
      status: 'pending',
      dependsOn: ['sub-1']
    });

    let state = whiteboard.getState();
    assert.strictEqual(state.subtasks.length, 2);

    whiteboard.updateSubtaskStatus('sub-1', 'completed', 'Identified 3 callers');
    state = whiteboard.getState();
    assert.strictEqual(state.subtasks[0].status, 'completed');
    assert.strictEqual(state.subtasks[0].output, 'Identified 3 callers');
  });

  it('should create checkpoints and support state rollback', () => {
    whiteboard.initTask('Transactional refactoring');
    whiteboard.recordModifiedFile('src/auth.ts');

    const cpId = whiteboard.createCheckpoint('Pre-patch baseline');
    assert.ok(cpId.startsWith('cp_'));

    // Introduce modifications
    whiteboard.recordModifiedFile('src/badEdit.ts');
    assert.strictEqual(whiteboard.getState().modifiedFiles.length, 2);

    // Rollback
    const success = whiteboard.rollbackToCheckpoint(cpId);
    assert.strictEqual(success, true);
    assert.deepStrictEqual(whiteboard.getState().modifiedFiles, ['src/auth.ts']);
    assert.ok(whiteboard.getState().scratchpad.includes('Rolled back state to checkpoint'));
  });
});
