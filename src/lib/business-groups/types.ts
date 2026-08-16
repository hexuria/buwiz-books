export interface AccessibleGroupEntity {
  id: string;
  organizationId: string;
  name: string;
  role: string;
  currency: string;
}

export interface GroupEntityAccessView {
  entities: AccessibleGroupEntity[];
  totalEntityCount: number;
  omittedEntityCount: number;
  isComplete: boolean;
}

export interface AccessibleBusinessGroupView {
  enterpriseAccountId: string;
  groupId: string;
  groupName: string;
  access: GroupEntityAccessView;
}
