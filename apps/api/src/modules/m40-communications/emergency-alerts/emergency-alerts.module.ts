import { Module } from '@nestjs/common';
import { TenantModule } from '@modules/m00-platform';
import { IamModule } from '@modules/m00-platform';
import { KafkaModule } from '@shared/kafka';
import { AlertTypeService } from './alert-type.service';
import { EmergencyAlertService } from './emergency-alert.service';
import { AlertTypeController } from './alert-type.controller';
import {
  EmergencyAlertController,
  EmergencyAlertDeliveryController,
} from './emergency-alert.controller';

/**
 * EmergencyAlertsModule — Cycle 14 Step 5.
 *
 * Wires AlertTypeService (school-configurable severity catalogue
 * CRUD, admin only via com-004:write) and EmergencyAlertService
 * (issue keystone with multi-channel delivery fan-out + resolve +
 * recipient acknowledgement + status rollup).
 *
 * Endpoints under /messaging/alert-types and
 * /messaging/emergency-alerts and /messaging/emergency-alert-deliveries.
 *
 * Imports TenantModule, IamModule (PermissionCheckService for
 * issuer scope checks), KafkaModule (msg.emergency.issued emit).
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule],
  providers: [AlertTypeService, EmergencyAlertService],
  controllers: [AlertTypeController, EmergencyAlertController, EmergencyAlertDeliveryController],
  exports: [AlertTypeService, EmergencyAlertService],
})
export class EmergencyAlertsModule {}
