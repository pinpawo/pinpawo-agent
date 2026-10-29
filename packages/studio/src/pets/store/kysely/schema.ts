/** Studio's Pet instances and their credentials in the Studio database. */
export type PetDatabase = {
  studio_pets: {
    pet_id: string;
    definition_id: string;
    name: string;
    created_at: string;
  };
  studio_pet_credentials: {
    pet_id: string;
    env_name: string;
    /** AES-256-GCM envelope; the key never enters the database. */
    encrypted_value: string;
    updated_at: string;
  };
};
