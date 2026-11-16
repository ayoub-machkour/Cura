/**
 * Règle d'accès UNIQUE aux dossiers et rendez-vous, utilisée par tous les modules.
 *
 *  - patient    : son propre dossier + les proches rattachés à son compte famille ;
 *  - médecin    : les dossiers du cabinet ; pour agir sur un RDV, uniquement ceux de SON agenda ;
 *  - secrétariat / admin : tout le cabinet.
 *
 * Hors périmètre, les appelants répondent 404 : on ne révèle pas l'existence d'une donnée.
 */
import type { AuthPrincipal } from '../../common/security/tokens';
import type { FamilyRepository } from './family.repository';

export class PatientAccess {
  constructor(private readonly family: FamilyRepository) {}

  /** Dossiers qu'un patient gère : le sien puis ceux de ses proches. Vide pour le personnel. */
  async managedPatientIds(principal: AuthPrincipal): Promise<string[]> {
    if (principal.role !== 'patient' || !principal.pid) return [];
    return [principal.pid, ...(await this.family.dependentIds(principal.sub))];
  }

  async canAccessPatient(principal: AuthPrincipal, patientId: string): Promise<boolean> {
    if (principal.role !== 'patient') return true;
    if (principal.pid === patientId) return true;
    return this.family.isGuardian(principal.sub, patientId);
  }

  async canActOnAppointment(principal: AuthPrincipal, appt: { patientId: string; doctorId: string }): Promise<boolean> {
    switch (principal.role) {
      case 'patient':
        return this.canAccessPatient(principal, appt.patientId);
      case 'doctor':
        return principal.did !== null && appt.doctorId === principal.did;
      case 'secretary':
      case 'admin':
        return true;
    }
  }
}
