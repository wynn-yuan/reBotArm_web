"""reBotArm backend service (rebot-server).

Phase 7I scope: motorbridge CAN scan, active-report telemetry, and separately
gated user-confirmed write capabilities.

Safety posture:
  * Scans are strictly read-only (ping only); they never enable or move motors.
  * ``connected`` requires every expected motor ID (1..7) to respond;
    anything less is ``partial`` — never presented as success.
  * Everything fails closed: missing SDK or broken config yields ``error``,
    never a fake success.
  * Action-center, homing, set-zero, aging, and general motion-control
    endpoints remain unavailable. Zero-torque is a separately gated,
    backend-owned reference-script state machine.
"""

__version__ = "0.1.0"
SERVICE_NAME = "rebot-server"

__all__ = ["__version__", "SERVICE_NAME"]
