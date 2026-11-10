import { Bike, Bus, Car, CarFront, CarTaxiFront, Gem, type LucideIcon } from "lucide-react";

const BY_CODE: Record<string, LucideIcon> = { BIKE: Bike, AUTO: CarTaxiFront, MINI: Car, SEDAN: CarFront, SUV: CarFront, PREMIUM: Gem, XL: Bus };
/** One recognisable icon per vehicle type; anything unknown gets a plain car. */
export const vehicleIcon = (code?: string | null): LucideIcon => (code && BY_CODE[code.toUpperCase()]) || Car;
