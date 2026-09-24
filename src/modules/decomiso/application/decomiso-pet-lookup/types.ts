// Exported types for the decomiso pet lookup use-case.

export type GovtPetLookupResult =
  | { found: false; error: string }
  | {
      found: true;
      id: string;
      publicToken: string;
      name: string;
      species: string;
      sex: string;
      status: string;
      /** true when there is an active 'owner' ownership row with a user_id */
      hasOwner: boolean;
      ownerDisplayName: string | null;
    };
