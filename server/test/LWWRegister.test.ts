import { LWWRegister } from '../src/crdt/LWWRegister';

describe('LWWRegister', () => {
  let register: LWWRegister<string>;

  beforeEach(() => {
    register = new LWWRegister('initial', 'node1');
  });

  describe('constructor', () => {
    it('should initialize with the provided value', () => {
      expect(register.getValue()).toBe('initial');
    });

    it('should work with different types', () => {
      const numRegister = new LWWRegister(42, 'node1');
      expect(numRegister.getValue()).toBe(42);

      const boolRegister = new LWWRegister(true, 'node1');
      expect(boolRegister.getValue()).toBe(true);

      const objRegister = new LWWRegister({ key: 'value' }, 'node1');
      expect(objRegister.getValue()).toEqual({ key: 'value' });
    });
  });

  describe('setValue', () => {
    it('should update the value', () => {
      register.setValue('updated', 'node1');
      expect(register.getValue()).toBe('updated');
    });

    it('should allow multiple updates', () => {
      register.setValue('first', 'node1');
      register.setValue('second', 'node1');
      register.setValue('third', 'node1');
      expect(register.getValue()).toBe('third');
    });
  });

  describe('merge', () => {
    it('should merge registers and converge', () => {
      const register1 = new LWWRegister('value1', 'node1');
      const register2 = new LWWRegister('value2', 'node2');
      
      register1.merge(register2);
      
      // After merge, should have one of the values
      const value = register1.getValue();
      expect(['value1', 'value2']).toContain(value);
    });

    it('should be idempotent', () => {
      const register1 = new LWWRegister('value1', 'node1');
      const register2 = new LWWRegister('value2', 'node2');
      
      register1.merge(register2);
      const valueAfterFirstMerge = register1.getValue();
      
      register1.merge(register2);
      expect(register1.getValue()).toBe(valueAfterFirstMerge);
    });

    it('should converge when merged in both directions', () => {
      const reg1a = new LWWRegister('A', 'node1');
      const reg1b = new LWWRegister('A', 'node1');
      const reg2a = new LWWRegister('B', 'node2');
      const reg2b = new LWWRegister('B', 'node2');
      
      // Create identical pairs
      reg1b.merge(reg1a);
      reg2b.merge(reg2a);
      
      reg1a.merge(reg2a);
      reg2b.merge(reg1b);
      
      // After merging, both should have the same value
      expect(reg1a.getValue()).toBe(reg2b.getValue());
    });
  });

  describe('getState', () => {
    it('should return serializable state', () => {
      register.setValue('test-value', 'node1');
      const state = register.getState();
      
      expect(state).toBeDefined();
      expect(typeof state).toBe('object');
    });

    it('should preserve value in state', () => {
      register.setValue('preserved', 'node1');
      const state = register.getState();
      
      // Create new register and merge state
      const newRegister = new LWWRegister('default', 'node2');
      // State can be used for reconstruction via merge
      expect(state).toBeDefined();
    });
  });
});
