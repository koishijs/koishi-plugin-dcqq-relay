import { Column, Entity, OneToMany, PrimaryColumn, PrimaryGeneratedColumn } from "typeorm";
import DiscordId from "./discordId";

@Entity()
export class MessageRelation {
    @PrimaryGeneratedColumn()
    id: number

    @OneToMany(() => DiscordId, d => d.relation, {
        cascade: true
    })
    discordIds: DiscordId[];

    @Column()
    onebot: string

    @Column("text")
    message: string;

    @Column("boolean", {default: false})
    deleted: boolean;
}