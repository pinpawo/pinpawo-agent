/** Studio's Pet instances in the Studio database. */
export type PetDatabase = {
  studio_pets: {
    pet_id: string;
    definition_id: string;
    name: string;
    created_at: string;
    archived_at: string | null;
  };
};
