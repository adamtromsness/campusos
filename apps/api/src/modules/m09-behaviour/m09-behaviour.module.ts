import { Module } from '@nestjs/common';
import { DisciplineModule } from './discipline/discipline.module';
import { BehaviorPlansModule } from './behavior-plans/behavior-plans.module';
import { BehaviourAdvancedModule } from './behaviour-advanced/behaviour-advanced.module';

/**
 * M09 Behaviour — canonical aggregator for discipline, behaviour
 * intervention plans, and behaviour-advanced.
 */
@Module({
  imports: [DisciplineModule, BehaviorPlansModule, BehaviourAdvancedModule],
  exports: [DisciplineModule, BehaviorPlansModule, BehaviourAdvancedModule],
})
export class M09BehaviourModule {}
